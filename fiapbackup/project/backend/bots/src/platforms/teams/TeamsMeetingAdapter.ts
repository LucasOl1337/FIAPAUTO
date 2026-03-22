import path from 'node:path'
import {
  chromium,
  type BrowserContext,
  type Download,
  type Frame,
  type Locator,
  type Page,
} from 'playwright'
import type {
  AssignmentItem,
  JoinedMeeting,
  RecordingJob,
  TeamsScanResult,
} from '../../types'
import { BotLogger } from '../../services/BotLogger'
import { ensureDir } from '../../../../database/fs.ts'

type AssignmentTabStatus = AssignmentItem['status']

type AssignmentSummary = {
  id: string
  title: string
  dueText: string
  course: string
  status: AssignmentTabStatus
}

type TeamsSurface = Page | Frame

const ASSIGNMENT_TABS: Array<{ label: RegExp; status: AssignmentTabStatus }> = [
  { label: /em breve|upcoming/i, status: 'upcoming' },
  { label: /em atraso|late|overdue/i, status: 'late' },
  { label: /concluida|completed/i, status: 'completed' },
]

export class TeamsMeetingAdapter {
  private static sessionContext: BrowserContext | null = null
  private readonly screenshotsDir: string
  private readonly headless: boolean
  private readonly sessionDir: string
  private readonly downloadsDir: string
  private readonly logger: BotLogger

  constructor(
    screenshotsDir: string,
    headless: boolean,
    sessionDir: string,
    downloadsDir: string,
    logger: BotLogger,
  ) {
    this.screenshotsDir = screenshotsDir
    this.headless = headless
    this.sessionDir = sessionDir
    this.downloadsDir = downloadsDir
    this.logger = logger
  }

  async joinMeeting(job: RecordingJob): Promise<JoinedMeeting> {
    await ensureDir(this.screenshotsDir)
    await ensureDir(this.sessionDir)
    await ensureDir(this.downloadsDir)

    const allowMockMeeting = job.captureMode === 'mock' || job.meetingUrl.startsWith('file:')
    const context = allowMockMeeting
      ? await this.createContext()
      : await this.getOrCreateSessionContext()

    try {
      const page = await this.getPrimaryPage(context)
      await page.goto(job.meetingUrl, { waitUntil: 'domcontentloaded' })
      await page.bringToFront().catch(() => null)
      await page.waitForTimeout(2_000)

      if (!allowMockMeeting && !(await this.isAuthenticated(page))) {
        throw new Error('teams_login_required')
      }

      await this.clickFirst(page, [
        /continue on this browser/i,
        /continuar neste navegador/i,
        /join now/i,
        /participar agora/i,
        /join meeting/i,
        /ingressar/i,
      ])

      await page.waitForTimeout(1_500)

      const screenshotPath = path.join(this.screenshotsDir, `${job.id}.png`)
      await page.screenshot({ path: screenshotPath, fullPage: true })

      return {
        meetingUrl: job.meetingUrl,
        joinedAt: new Date().toISOString(),
        sessionLabel: `teams-session:${job.id}`,
      }
    } finally {
      if (allowMockMeeting) {
        await context.close()
      }
    }
  }

  async connectSession(timeoutMs = 120_000): Promise<TeamsScanResult> {
    await this.logger.info('Abrindo sessao persistente do Teams')
    const context = await this.getOrCreateSessionContext()
    const page = await this.getPrimaryPage(context)
    await page.goto('https://teams.microsoft.com/v2/', { waitUntil: 'domcontentloaded' })
    await page.bringToFront().catch(() => null)

    if (await this.isAuthenticated(page)) {
      await this.logger.info('Sessao do Teams ja estava autenticada')
      return this.scanAuthenticatedWorkspace(context, page)
    }

    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      await page.waitForTimeout(2_000)
      if (await this.isAuthenticated(page)) {
        await this.logger.info('Login do Teams concluido durante a espera')
        return this.scanAuthenticatedWorkspace(context, page)
      }
    }

    await this.logger.warn('Sessao do Teams ainda nao foi autenticada')
    return { authStatus: 'login_required', liveMeetings: [], assignments: [] }
  }

  async openSessionWindow(): Promise<TeamsScanResult> {
    await this.logger.info('Abrindo janela do Teams para login manual')
    const context = await this.getOrCreateSessionContext()
    const page = await this.getPrimaryPage(context)
    await page.goto('https://teams.microsoft.com/v2/', { waitUntil: 'domcontentloaded' })
    await page.bringToFront().catch(() => null)
    await page.waitForTimeout(1_000)

    if (await this.isAuthenticated(page)) {
      await this.logger.info('Janela aberta com sessao autenticada')
      return this.scanAuthenticatedWorkspace(context, page)
    }

    await this.logger.warn('Janela do Teams aberta, aguardando login manual')
    return { authStatus: 'login_required', liveMeetings: [], assignments: [] }
  }

  async scanWorkspace(): Promise<TeamsScanResult> {
    await this.logger.info('Iniciando varredura do Teams')
    const context = await this.getOrCreateSessionContext()
    const page = await this.getPrimaryPage(context)
    await page.goto('https://teams.microsoft.com/v2/', { waitUntil: 'domcontentloaded' })
    await page.bringToFront().catch(() => null)
    await page.waitForTimeout(3_000)

    if (!(await this.isAuthenticated(page))) {
      await this.logger.warn('Varredura interrompida: Teams nao autenticado')
      await this.capturePage(page, 'teams-login-required.png')
      return { authStatus: 'login_required', liveMeetings: [], assignments: [] }
    }

    await this.logger.info(`Varredura iniciada em ${page.url()}`)
    return this.scanAuthenticatedWorkspace(context, page)
  }

  async getSessionAuthStatus(): Promise<TeamsScanResult['authStatus']> {
    try {
      const context = await this.getOrCreateSessionContext()
      const page = await this.getPrimaryPage(context)
      await page.goto('https://teams.microsoft.com/v2/', { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(1_500)

      return (await this.isAuthenticated(page)) ? 'authenticated' : 'login_required'
    } catch {
      return 'login_required'
    }
  }

  private async createContext() {
    await ensureDir(this.screenshotsDir)
    await ensureDir(this.sessionDir)
    await ensureDir(this.downloadsDir)

    return chromium.launchPersistentContext(this.sessionDir, {
      headless: this.headless,
      acceptDownloads: true,
      viewport: { width: 1440, height: 960 },
      args: ['--hide-crash-restore-bubble', '--disable-session-crashed-bubble'],
    })
  }

  private async getOrCreateSessionContext() {
    if (await this.hasReusableSessionContext()) {
      return TeamsMeetingAdapter.sessionContext as BrowserContext
    }

    TeamsMeetingAdapter.sessionContext = await this.createContext()
    return TeamsMeetingAdapter.sessionContext
  }

  private async getPrimaryPage(context: BrowserContext) {
    return context.pages()[0] ?? (await context.newPage())
  }

  private async getLivePage(context: BrowserContext, fallbackPage?: Page) {
    if (fallbackPage && !fallbackPage.isClosed()) {
      return fallbackPage
    }

    try {
      const existingPage = context.pages().find((item) => !item.isClosed())
      if (existingPage) {
        return existingPage
      }
    } catch {
      TeamsMeetingAdapter.sessionContext = null
      const fresh = await this.getOrCreateSessionContext()
      return this.getPrimaryPage(fresh)
    }

    return context.newPage()
  }

  private async hasReusableSessionContext() {
    if (!TeamsMeetingAdapter.sessionContext) {
      return false
    }

    try {
      void TeamsMeetingAdapter.sessionContext.pages()
      return true
    } catch {
      TeamsMeetingAdapter.sessionContext = null
      return false
    }
  }

  private async scanAuthenticatedWorkspace(
    context: BrowserContext,
    page: Page,
  ): Promise<TeamsScanResult> {
    await this.logger.info('Coletando atribuicoes')
    const activePage = await this.getLivePage(context, page)
    const assignments = await this.collectAssignments(context, activePage)
    await this.capturePage(await this.getLivePage(context, activePage), 'teams-workspace.png')
    await this.logger.info(`Varredura concluida: ${assignments.length} atribuicoes`)

    return {
      authStatus: 'authenticated',
      liveMeetings: [],
      assignments,
    }
  }

  private async collectAssignments(context: BrowserContext, page: Page): Promise<AssignmentItem[]> {
    await this.logger.info('Tentando abrir Atribuicoes')
    page = await this.openAssignmentsSection(context, page)
    await this.ensureAssignmentsView(page)
    await page.waitForTimeout(1_500)

    const summaries: AssignmentSummary[] = []

    for (const tab of ASSIGNMENT_TABS) {
      await this.logger.info(`Coletando cards da aba ${statusLabel(tab.status)}`)
      const tabSummaries = await this.collectAssignmentSummariesForTab(page, tab.label, tab.status)
      summaries.push(...tabSummaries)
    }

    const assignments: AssignmentItem[] = []
    for (const summary of dedupeAssignmentSummaries(summaries)) {
      await this.logger.info(`Processando atribuicao: ${summary.title}`)
      assignments.push(await this.processAssignmentSummary(context, page, summary))
    }

    return assignments
  }

  private async openAssignmentsSection(context: BrowserContext, page: Page) {
    page = await this.getLivePage(context, page)
    await this.logger.info('Tentando navegar para a secao Atribuicoes')

    await page.bringToFront().catch(() => null)
    const openedByShortcut = await this.tryAssignmentsShortcut(page)
    if (openedByShortcut) {
      await this.logger.info(`Atribuicoes aberta via atalho. URL atual: ${page.url()}`)
      return this.getLivePage(context, page)
    }

    const clickedDirect = await this.clickAssignmentsSidebarShortcut(page)
    if (clickedDirect) {
      await page.waitForTimeout(1_000)
      await this.logger.info(`Clique direto na sidebar de Atribuicoes executado. URL atual: ${page.url()}`)
      return this.getLivePage(context, page)
    }

    const clicked = await this.clickSidebarSectionByNormalizedText(page, ['atribuicoes', 'assignments'])
    if (clicked) {
      await page.waitForTimeout(1_200)
      await this.logger.info(`Clique em Atribuicoes executado. URL atual: ${page.url()}`)
      return this.getLivePage(context, page)
    }

    await this.logger.warn('Secao Atribuicoes nao encontrada no menu lateral')
    return this.getLivePage(context, page)
  }

  private async tryAssignmentsShortcut(page: Page) {
    await this.logger.info('Tentando atalho Ctrl+Shift+2 para abrir Atribuicoes')
    await page.locator('body').click({ position: { x: 240, y: 140 } }).catch(() => null)
    await page.waitForTimeout(200)

    const shortcuts: Array<{ label: string; run: () => Promise<void> }> = [
      {
        label: 'Control+Shift+Digit2',
        run: async () => {
          await page.keyboard.down('Control')
          await page.keyboard.down('Shift')
          await page.keyboard.press('Digit2')
          await page.keyboard.up('Shift')
          await page.keyboard.up('Control')
        },
      },
      {
        label: 'Control+Shift+2',
        run: async () => {
          await page.keyboard.press('Control+Shift+2')
        },
      },
    ]

    for (const shortcut of shortcuts) {
      await this.logger.info(`Disparando atalho ${shortcut.label}`)
      await shortcut.run().catch(() => null)
      await page.waitForTimeout(1_200)

      if (await this.hasAssignmentsAnchors(page)) {
        await this.logger.info(`Atalho ${shortcut.label} confirmou a tela de atribuicoes`)
        return true
      }

      await this.logger.warn(
        `Atalho ${shortcut.label} nao confirmou a tela de atribuicoes. Titulo atual: ${await page.title().catch(() => '')}`,
      )
    }

    return false
  }

  private async clickAssignmentsSidebarShortcut(page: Page) {
    const candidates = [
      page.getByRole('link', { name: /atribuicoes|atribuições|trabalhos|assignments/i }).first(),
      page.getByRole('button', { name: /atribuicoes|atribuições|trabalhos|assignments/i }).first(),
      page.getByText(/^Atribuições$/i).first(),
      page.getByText(/^Trabalhos$/i).first(),
      page.locator('[aria-label*="Atribui"]').first(),
      page.locator('[title*="Atribui"]').first(),
      page.locator('button:has-text("Atribuições")').first(),
      page.locator('a:has-text("Atribuições")').first(),
      page.locator('button:has-text("Trabalhos")').first(),
      page.locator('a:has-text("Trabalhos")').first(),
      page.locator('button:has-text("Assignments")').first(),
      page.locator('a:has-text("Assignments")').first(),
    ]

    for (const candidate of candidates) {
      if (!(await candidate.count())) {
        continue
      }

      await candidate.click().catch(() => null)
      return true
    }

    return false
  }

  private async collectAssignmentSummariesForTab(page: Page, tabLabel: RegExp, status: AssignmentTabStatus) {
    let surface = await this.resolveAssignmentsSurface(page)
    await this.openAssignmentTab(page, surface, tabLabel)
    surface = await this.waitForAssignmentsTabContent(page, status)
    await this.scrollAssignmentsToTop(surface, page)

    const summaries: AssignmentSummary[] = []
    let stableRounds = 0
    let previousCount = -1

    for (let round = 0; round < 12; round += 1) {
      surface = await this.resolveAssignmentsSurface(page)
      const found = await this.extractAssignmentSummariesFromPage(surface, status)
      mergeAssignmentSummaries(summaries, found)

      if (summaries.length === previousCount) {
        stableRounds += 1
      } else {
        stableRounds = 0
        previousCount = summaries.length
      }

      if (stableRounds >= 2) {
        break
      }

      await this.scrollAssignmentsBy(surface, page, 1200)
      await page.waitForTimeout(700)
    }

    await this.logger.info(
      `Aba ${statusLabel(status)} coletada com ${summaries.length} card(s) identificado(s)`,
    )
    return summaries
  }

  private async waitForAssignmentsTabContent(page: Page, status: AssignmentTabStatus) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const surface = await this.resolveAssignmentsSurface(page)
      const bodyText = await surface.locator('body').innerText().catch(() => '')
      const normalizedBody = normalizeText(bodyText)

      if (
        normalizedBody.includes('prazo de entrega') ||
        normalizedBody.includes('due') ||
        normalizedBody.includes('sem pontos') ||
        normalizedBody.includes('materiais de referencia')
      ) {
        await this.logger.info(
          `Conteudo reconhecido na aba ${statusLabel(status)} via superficie ${this.describeSurface(surface)}`,
        )
        return surface
      }

      await page.waitForTimeout(700)
    }

    const fallbackSurface = await this.resolveAssignmentsSurface(page)
    const snippet = (await fallbackSurface.locator('body').innerText().catch(() => ''))
      .replace(/\s+/g, ' ')
      .slice(0, 280)

    await this.logger.warn(
      `Aba ${statusLabel(status)} ainda sem conteudo reconhecivel apos espera. Superficie: ${this.describeSurface(fallbackSurface)}. Trecho do body: ${snippet}`,
    )
    return fallbackSurface
  }

  private async processAssignmentSummary(
    context: BrowserContext,
    page: Page,
    summary: AssignmentSummary,
  ): Promise<AssignmentItem> {
    const targetDir = path.join(this.downloadsDir, 'atribuicoes', slugify(summary.title))
    await ensureDir(targetDir)
    const screenshotFiles: string[] = []

    try {
      page = await this.openAssignmentsSection(context, page)
      await this.ensureAssignmentsView(page)
      let surface = await this.resolveAssignmentsSurface(page)
      await this.openAssignmentTab(page, surface, tabLabelForStatus(summary.status))
      surface = await this.waitForAssignmentsTabContent(page, summary.status)
      await this.scrollAssignmentsToTop(surface, page)
      const listScreenshot = await this.captureAssignmentStageScreenshot(
        page,
        targetDir,
        `${slugify(summary.title)}-list.png`,
      )
      if (listScreenshot) {
        screenshotFiles.push(listScreenshot)
      }
      page = await this.findAndOpenAssignmentCard(context, page, surface, summary)
      surface = await this.resolveAssignmentsSurface(page)
      await this.waitForAssignmentDetail(surface, page, summary)
      const detailScreenshot = await this.captureAssignmentStageScreenshot(
        page,
        targetDir,
        `${slugify(summary.title)}-detail.png`,
      )
      if (detailScreenshot) {
        screenshotFiles.push(detailScreenshot)
      }

      const downloadedFiles = await this.downloadReferenceMaterials(context, page, surface, targetDir)
      const detailUrl = page.url()
      await this.returnToAssignmentsList(surface, page)
      await this.logger.info(
        `Atribuicao processada: ${summary.title} com ${downloadedFiles.length} arquivo(s) baixado(s)`,
      )

      return {
        id: summary.id,
        title: summary.title,
        dueText: summary.dueText,
        course: summary.course,
        status: summary.status,
        detailUrl,
        downloadedFiles,
        screenshotFiles,
        localFolder: targetDir,
        capturedAt: new Date().toISOString(),
      }
    } catch (error) {
      await this.logger.error(
        `Falha ao processar atribuicao ${summary.title}: ${error instanceof Error ? error.message : 'erro_desconhecido'}`,
      )
      const surface = await this.resolveAssignmentsSurface(page).catch(() => page)
      await this.returnToAssignmentsList(surface, page).catch(() => null)

      return {
        id: summary.id,
        title: summary.title,
        dueText: summary.dueText,
        course: summary.course,
        status: summary.status,
        downloadedFiles: [],
        screenshotFiles,
        localFolder: targetDir,
        error: error instanceof Error ? error.message : 'assignment_processing_failed',
        capturedAt: new Date().toISOString(),
      }
    }
  }

  private async openAssignmentTab(page: Page, surface: TeamsSurface, label: RegExp) {
    const targets = surface === page ? [surface] : [surface, page]

    for (const target of targets) {
      const tab = target.getByRole('tab', { name: label }).first()
      if (await tab.count()) {
        await tab.click().catch(() => null)
        await page.waitForTimeout(1_000)
        await this.logger.info(
          `Aba de atribuicoes aberta via tab: ${label} na superficie ${this.describeSurface(target)}`,
        )
        return
      }

      const button = target.getByRole('button', { name: label }).first()
      if (await button.count()) {
        await button.click().catch(() => null)
        await page.waitForTimeout(1_000)
        await this.logger.info(
          `Aba de atribuicoes aberta via botao: ${label} na superficie ${this.describeSurface(target)}`,
        )
        return
      }

      const text = target.getByText(label).first()
      if (await text.count()) {
        await text.click().catch(() => null)
        await page.waitForTimeout(1_000)
        await this.logger.info(
          `Aba de atribuicoes aberta via texto: ${label} na superficie ${this.describeSurface(target)}`,
        )
        return
      }
    }
  }

  private async scrollAssignmentsToTop(surface: TeamsSurface, page: Page) {
    await surface
      .evaluate(() => {
        window.scrollTo({ top: 0, behavior: 'instant' })
        document.scrollingElement?.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
      })
      .catch(() => null)
    await page.waitForTimeout(400)
  }

  private async scrollAssignmentsBy(surface: TeamsSurface, page: Page, offsetY: number) {
    await surface
      .evaluate((delta) => {
        window.scrollBy({ top: delta, behavior: 'instant' })
        document.scrollingElement?.scrollBy({ top: delta, behavior: 'instant' as ScrollBehavior })
      }, offsetY)
      .catch(() => null)
    await page.mouse.wheel(0, offsetY).catch(() => null)
  }

  private async extractAssignmentSummariesFromPage(surface: TeamsSurface, status: AssignmentTabStatus) {
    const dueMarkers = surface.getByText(/prazo de entrega|due/i)
    const markerCount = await dueMarkers.count()
    const items: AssignmentSummary[] = []

    await this.logger.info(
      `Aba ${statusLabel(status)} com ${markerCount} marcador(es) de prazo visivel(is) na superficie ${this.describeSurface(surface)}`,
    )

    for (let index = 0; index < markerCount; index += 1) {
      const summary = await this.extractAssignmentSummaryFromDeadline(dueMarkers.nth(index), status)
      if (!summary) {
        continue
      }

      if (items.some((item) => item.title === summary.title && item.dueText === summary.dueText)) {
        continue
      }

      items.push(summary)
    }

    return items
  }

  private async extractAssignmentSummaryFromDeadline(
    deadlineLocator: Locator,
    status: AssignmentTabStatus,
  ) {
    const candidates = [
      deadlineLocator.locator('xpath=ancestor::button[1]'),
      deadlineLocator.locator('xpath=ancestor::*[@role="button"][1]'),
      deadlineLocator.locator('xpath=ancestor::article[1]'),
      deadlineLocator.locator('xpath=ancestor::li[1]'),
      deadlineLocator.locator('xpath=ancestor::div[1]'),
      deadlineLocator.locator('xpath=ancestor::div[2]'),
      deadlineLocator.locator('xpath=ancestor::div[3]'),
      deadlineLocator.locator('xpath=ancestor::div[4]'),
    ]

    for (const candidate of candidates) {
      if (!(await candidate.count())) {
        continue
      }

      if (!(await candidate.isVisible().catch(() => false))) {
        continue
      }

      const box = await candidate.boundingBox().catch(() => null)
      if (!box || box.width < 320 || box.height < 40 || box.height > 260) {
        continue
      }

      const text = (await candidate.innerText().catch(() => '')).trim()
      const summary = parseAssignmentSummaryFromCardText(text, status)
      if (summary) {
        return summary
      }
    }

    return null
  }

  private async findAndOpenAssignmentCard(
    context: BrowserContext,
    page: Page,
    surface: TeamsSurface,
    summary: AssignmentSummary,
  ) {
    for (let round = 0; round < 12; round += 1) {
      page = await this.getLivePage(context, page)
      surface = await this.resolveAssignmentsSurface(page)
      const titleNode = surface.getByText(summary.title, { exact: false }).first()
      if (await titleNode.count()) {
        await titleNode.scrollIntoViewIfNeeded().catch(() => null)
        await titleNode.click().catch(() => null)
        await page.waitForTimeout(1_200)
        const nextSurface = await this.resolveAssignmentsSurface(page)
        if (await this.isAssignmentDetailVisible(nextSurface, page, summary)) {
          return this.getLivePage(context, page)
        }
      }

      const card = this.findAssignmentCard(surface, summary)

      if (await card.count()) {
        await card.scrollIntoViewIfNeeded().catch(() => null)
        await card.click().catch(() => null)
        await page.waitForTimeout(1_200)
        const nextSurface = await this.resolveAssignmentsSurface(page)
        if (await this.isAssignmentDetailVisible(nextSurface, page, summary)) {
          return this.getLivePage(context, page)
        }
      }

      await this.scrollAssignmentsBy(surface, page, 1000)
      await page.waitForTimeout(600)
    }

    throw new Error(`assignment_not_found:${summary.title}`)
  }

  private findAssignmentCard(surface: TeamsSurface, summary: AssignmentSummary) {
    let card = surface
      .locator('button, [role="button"], article, li, div')
      .filter({ hasText: summary.title })
      .filter({ has: surface.getByText(/prazo de entrega|due/i).first() })

    if (summary.course) {
      card = card.filter({ hasText: summary.course })
    }
    if (summary.dueText) {
      card = card.filter({ hasText: summary.dueText })
    }
    return card.first()
  }

  private async waitForAssignmentDetail(surface: TeamsSurface, page: Page, summary: AssignmentSummary) {
    await page.waitForTimeout(1_000)
    if (await this.isAssignmentDetailVisible(surface, page, summary)) {
      return
    }

    throw new Error(`assignment_detail_not_loaded:${summary.title}`)
  }

  private async isAssignmentDetailVisible(surface: TeamsSurface, page: Page, summary: AssignmentSummary) {
    const title = surface.getByText(summary.title, { exact: false }).first()
    if ((await title.count()) && (await title.isVisible().catch(() => false))) {
      const materials = surface.getByText(/materiais de referencia|reference materials/i).first()
      const instructions = surface.getByText(/instrucoes|instructions/i).first()
      if ((await materials.count()) || (await instructions.count())) {
        return true
      }
    }

    const backControl = surface.getByRole('button', { name: /voltar|back/i }).first()
    if (await backControl.count()) {
      return true
    }

    const pageBackControl = page.getByRole('button', { name: /voltar|back/i }).first()
    if (await pageBackControl.count()) {
      return true
    }

    return false
  }

  private async downloadReferenceMaterials(
    context: BrowserContext,
    page: Page,
    surface: TeamsSurface,
    targetDir: string,
  ) {
    const fileNames = await this.extractReferenceMaterialNames(surface)
    const downloadedFiles: string[] = []

    for (const fileName of fileNames) {
      page = await this.getLivePage(context, page)
      surface = await this.resolveAssignmentsSurface(page)
      const filePath = await this.downloadSingleReferenceMaterial(surface, page, fileName, targetDir)
      if (filePath) {
        downloadedFiles.push(filePath)
      }
    }

    return dedupeStrings(downloadedFiles)
  }

  private async extractReferenceMaterialNames(surface: TeamsSurface) {
    return surface.evaluate(() => {
      const items: string[] = []
      const candidates = Array.from(document.querySelectorAll<HTMLElement>('div, a, button, span'))

      for (const element of candidates) {
        const rawText = element.innerText?.trim() ?? ''
        if (!rawText) {
          continue
        }

        for (const line of rawText.split('\n').map((item) => item.trim()).filter(Boolean)) {
          if (!/\.[a-z0-9]{2,5}(\.[a-z0-9]{2,5})?$/i.test(line)) {
            continue
          }

          if (!items.includes(line)) {
            items.push(line)
          }
        }
      }

      return items
    })
  }

  private async downloadSingleReferenceMaterial(
    surface: TeamsSurface,
    page: Page,
    fileName: string,
    targetDir: string,
  ) {
    await this.logger.info(`Tentando baixar material: ${fileName}`)
    const fileLabel = surface.getByText(fileName, { exact: false }).first()
    if (!(await fileLabel.count())) {
      return null
    }

    await fileLabel.scrollIntoViewIfNeeded().catch(() => null)
    const fileRow = this.findReferenceMaterialRow(fileLabel)

    const menuDownload = await this.downloadReferenceMaterialFromMenu(surface, page, fileRow, targetDir, fileName)
    if (menuDownload) {
      await this.logger.info(`Download concluido via menu: ${fileName}`)
      return menuDownload
    }

    const toolbarDownload = surface.getByRole('button', { name: /baixar|download/i }).first()
    if (await toolbarDownload.count()) {
      const result = await this.captureDownloadFromAction(
        page,
        async () => {
          await toolbarDownload.click().catch(() => null)
        },
        targetDir,
        fileName,
      )
      if (result) {
        await this.logger.info(`Download concluido via toolbar: ${fileName}`)
      }
      return result
    }

    const direct = await this.captureDownloadFromAction(
      page,
      async () => {
        await fileLabel.click().catch(() => null)
      },
      targetDir,
      fileName,
    )
    if (direct) {
      await this.logger.info(`Download concluido via clique direto: ${fileName}`)
      return direct
    }

    await this.logger.warn(`Nenhuma acao de download encontrada para ${fileName}`)
    return null
  }

  private findReferenceMaterialRow(fileLabel: Locator) {
    return fileLabel.locator('xpath=ancestor::div[.//button][1]')
  }

  private async downloadReferenceMaterialFromMenu(
    surface: TeamsSurface,
    page: Page,
    fileRow: Locator,
    targetDir: string,
    fileName: string,
  ) {
    const menuCandidates = [
      fileRow.getByRole('button', { name: /mais opcoes|mais opções|more options/i }).first(),
      fileRow.locator('button[aria-label*="Mais"]').first(),
      fileRow.locator('button[aria-label*="More"]').first(),
      fileRow.locator('button').last(),
    ]

    for (const menuButton of menuCandidates) {
      if (!(await menuButton.count())) {
        continue
      }

      await menuButton.click().catch(() => null)
      await page.waitForTimeout(400)

      const downloadMenuItem = surface.getByRole('menuitem', { name: /baixar|download/i }).first()
      if (await downloadMenuItem.count()) {
        const result = await this.captureDownloadFromAction(
          page,
          async () => {
            await downloadMenuItem.click().catch(() => null)
          },
          targetDir,
          fileName,
        )
        await page.keyboard.press('Escape').catch(() => null)
        if (result) {
          return result
        }
      }

      const downloadText = surface.getByText(/baixar|download/i).first()
      if (await downloadText.count()) {
        const result = await this.captureDownloadFromAction(
          page,
          async () => {
            await downloadText.click().catch(() => null)
          },
          targetDir,
          fileName,
        )
        await page.keyboard.press('Escape').catch(() => null)
        if (result) {
          return result
        }
      }

      await page.keyboard.press('Escape').catch(() => null)
    }

    return null
  }

  private async captureDownloadFromAction(
    page: Page,
    action: () => Promise<void>,
    targetDir: string,
    fallbackName: string,
  ) {
    try {
      const downloadPromise = page.waitForEvent('download', { timeout: 8_000 })
      await action()
      const download = await downloadPromise
      return this.saveDownload(download, targetDir, fallbackName)
    } catch {
      return null
    }
  }

  private async returnToAssignmentsList(surface: TeamsSurface, page: Page) {
    const backButton = surface.getByRole('button', { name: /voltar|back/i }).first()
    if (await backButton.count()) {
      await backButton.click().catch(() => null)
      await page.waitForTimeout(1_000)
      return
    }

    await page.goBack().catch(() => null)
    await page.waitForTimeout(1_000)
  }

  private async saveDownload(download: Download, targetDir: string, fallbackName: string) {
    await ensureDir(targetDir)
    const targetName = sanitizeFileName(download.suggestedFilename() || fallbackName)
    const targetPath = path.join(targetDir, targetName)
    await download.saveAs(targetPath)
    return targetPath
  }

  private async ensureAssignmentsView(page: Page) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (await this.hasAssignmentsAnchors(page)) {
        await this.logger.info('Tela de Atribuicoes confirmada')
        return
      }
      await page.waitForTimeout(1_000)
    }

    await this.capturePage(page, 'assignments-view-not-loaded.png')
    await this.logger.warn(
      `Tela de Atribuicoes nao confirmou. URL atual: ${page.url()}. Titulo atual: ${await page.title().catch(() => '')}`,
    )
    throw new Error('assignments_view_not_loaded')
  }

  private async hasAssignmentsAnchors(page: Page) {
    const pageTitle = await page.title().catch(() => '')
    const normalizedTitle = pageTitle
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()

    if (
      normalizedTitle.includes('trabalhos') ||
      normalizedTitle.includes('assignments') ||
      normalizedTitle.includes('atribuicoes')
    ) {
      return true
    }

    const anchors = [
      page.getByText(/trabalhos|assignments/i).first(),
      page.getByRole('heading', { name: /trabalhos|assignments/i }).first(),
      page.getByText(/em breve|upcoming/i).first(),
      page.getByText(/em atraso|late|overdue/i).first(),
      page.getByText(/concluida|completed/i).first(),
      page.getByText(/prazo de entrega|due/i).first(),
    ]

    for (const item of anchors) {
      if (await item.count()) {
        return true
      }
    }

    return false
  }

  private async resolveAssignmentsSurface(page: Page): Promise<TeamsSurface> {
    const surfaces: TeamsSurface[] = [page, ...page.frames()]
    let bestSurface: TeamsSurface = page
    let bestScore = Number.NEGATIVE_INFINITY

    for (const surface of surfaces) {
      const text = await surface.locator('body').innerText().catch(() => '')
      const normalized = normalizeText(text)
      let score = 0

      if (normalized.includes('prazo de entrega') || normalized.includes('due')) {
        score += 10
      }
      if (normalized.includes('em breve') || normalized.includes('upcoming')) {
        score += 4
      }
      if (normalized.includes('trabalhos') || normalized.includes('assignments')) {
        score += 4
      }
      if (normalized.includes('sem pontos')) {
        score += 2
      }
      if (normalized.includes('materiais de referencia')) {
        score += 2
      }

      if (score > bestScore) {
        bestScore = score
        bestSurface = surface
      }
    }

    return bestSurface
  }

  private describeSurface(surface: TeamsSurface) {
    if ('mainFrame' in surface) {
      return `page:${surface.url()}`
    }

    return `frame:${surface.url()}`
  }

  private async clickSidebarSectionByNormalizedText(page: Page, targets: string[]) {
    return page.evaluate((rawTargets) => {
      const targets = rawTargets.map((value) =>
        value
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .trim(),
      )
      const selectors =
        '[role="navigation"] a, [role="navigation"] button, nav a, nav button, aside a, aside button, [aria-label], [title]'
      const elements = Array.from(document.querySelectorAll<HTMLElement>(selectors))

      for (const element of elements) {
        const rect = element.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) {
          continue
        }

        const composed = [
          element.innerText,
          element.textContent,
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
        ]
          .filter(Boolean)
          .join(' ')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .trim()

        if (!composed) {
          continue
        }

        if (targets.some((target) => composed.includes(target))) {
          element.click()
          return true
        }
      }

      return false
    }, targets)
  }

  private async clickFirst(page: Page, patterns: RegExp[]) {
    for (const pattern of patterns) {
      const button = page.getByRole('button', { name: pattern }).first()
      if (await button.count()) {
        await button.click().catch(() => null)
        return true
      }

      const link = page.getByRole('link', { name: pattern }).first()
      if (await link.count()) {
        await link.click().catch(() => null)
        return true
      }
    }

    return false
  }

  private async capturePage(page: Page, fileName: string) {
    const screenshotPath = path.join(this.screenshotsDir, fileName)
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null)
  }

  private async captureAssignmentStageScreenshot(page: Page, targetDir: string, fileName: string) {
    const screenshotPath = path.join(targetDir, fileName)
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true })
      return screenshotPath
    } catch {
      return null
    }
  }

  private async isAuthenticated(page: Page) {
    const url = page.url()
    if (/login\.microsoftonline\.com|microsoft\.com\/auth/i.test(url)) {
      return false
    }

    const emailField = page.locator('input[type="email"], input[name="loginfmt"]').first()
    if (await emailField.count()) {
      return false
    }

    const passwordField = page.locator('input[type="password"]').first()
    if (await passwordField.count()) {
      return false
    }

    return /teams\.microsoft\.com/i.test(url) || (await page.locator('text=Teams').count()) > 0
  }
}

function tabLabelForStatus(status: AssignmentTabStatus) {
  if (status === 'late') {
    return /em atraso|late|overdue/i
  }

  if (status === 'completed') {
    return /concluida|completed/i
  }

  return /em breve|upcoming/i
}

function mergeAssignmentSummaries(target: AssignmentSummary[], incoming: AssignmentSummary[]) {
  for (const item of incoming) {
    if (target.some((existing) => existing.title === item.title && existing.dueText === item.dueText)) {
      continue
    }

    target.push(item)
  }
}

function dedupeAssignmentSummaries(items: AssignmentSummary[]) {
  const seen = new Set<string>()

  return items.filter((item) => {
    const key = `${item.title}::${item.dueText}`
    if (seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}

function dedupeStrings(items: string[]) {
  return Array.from(new Set(items))
}

function statusLabel(status: AssignmentTabStatus) {
  if (status === 'late') {
    return 'Em atraso'
  }

  if (status === 'completed') {
    return 'Concluida'
  }

  return 'Em breve'
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function sanitizeFileName(value: string) {
  const normalized = value.replace(/[<>:"/\\|?*]+/g, '-').trim()
  return normalized || `download-${Date.now()}`
}

function parseAssignmentSummaryFromCardText(
  text: string,
  status: AssignmentTabStatus,
): AssignmentSummary | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length < 2) {
    return null
  }

  const dueIndex = lines.findIndex((line) => {
    const normalized = normalizeText(line)
    return normalized.includes('prazo de entrega') || normalized.includes('due')
  })

  if (dueIndex === -1) {
    return null
  }

  const title =
    [...lines.slice(0, dueIndex)]
      .reverse()
      .find((line) => !isAssignmentGroupLabel(line) && !normalizeText(line).includes('prazo de entrega')) ??
    lines[0]

  const dueText = lines[dueIndex]
  const course =
    lines
      .slice(dueIndex + 1)
      .find((line) => !isAssignmentGroupLabel(line) && line !== title && line !== dueText) ?? ''

  if (!title || !dueText) {
    return null
  }

  return {
    id: `${title}::${dueText}`.toLowerCase(),
    title,
    dueText,
    course,
    status,
  }
}

function isAssignmentGroupLabel(value: string) {
  const normalized = normalizeText(value)
  return (
    /^(\d{1,2}\s+de\s+[a-z]+)|(\d{1,2}\s+[a-z]+\.)/.test(normalized) ||
    normalized.includes('mais adiante') ||
    normalized.includes('segunda-feira') ||
    normalized.includes('terca-feira') ||
    normalized.includes('quarta-feira') ||
    normalized.includes('quinta-feira') ||
    normalized.includes('sexta-feira') ||
    normalized.includes('sabado') ||
    normalized.includes('domingo')
  )
}

function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

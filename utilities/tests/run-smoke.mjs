import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..', '..')
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fiapauto-smoke-'))
const runtimeDir = path.join(tempRoot, 'runtime')
const publishedDir = path.join(rootDir, 'frontend', 'public', 'published')
const progressFile = path.join(rootDir, 'output', 'smoke-progress.log')
const adminToken = 'smoke-admin-token'
const publicPassword = 'smoke-pass'
const publicQuestion = 'o que preciso entregar?'
const smokeTopicTitle = 'Smoke Checkpoint Python'
const smokeTopicId = slugify(smokeTopicTitle)
const smokeNow = '2026-03-23T12:00:00.000Z'
const deadApiPort = 49999
const children = []
let browser = null

const ports = await reservePorts([44871, 44872, 44873, 44874, 44875])
const urls = {
  publicWeb: `http://127.0.0.1:${ports[0]}`,
  publicApi: `http://127.0.0.1:${ports[1]}`,
  adminWebOrigin: `http://127.0.0.1:${ports[2]}`,
  adminWeb: `http://127.0.0.1:${ports[2]}/admin/`,
  adminApi: `http://127.0.0.1:${ports[3]}`,
  publicFallbackWeb: `http://127.0.0.1:${ports[4]}`,
}

try {
  await resetProgressLog()
  await logStep('prepare_fixture:start')
  const fixture = await prepareFixture()
  await logStep('prepare_fixture:done')
  await logStep('ensure_chromium:start')
  await ensureChromiumInstalled()
  await logStep('ensure_chromium:done')
  await logStep('start_all:start')
  startAll(fixture)
  await logStep('start_all:done')

  await logStep('wait_services:start')
  await waitForJson(`${urls.publicApi}/api/public/manifest`, (payload) => typeof payload.releaseId === 'string')
  await waitForJson(`${urls.adminApi}/api/health`, (payload) => payload.ok === true)
  await waitForHttp(urls.publicWeb)
  await waitForHttp(urls.adminWeb)
  await waitForHttp(urls.publicFallbackWeb)
  await logStep('wait_services:done')

  await logStep('public_api_smoke:start')
  const publicState = await runPublicApiSmoke()
  await logStep('public_api_smoke:done')
  await logStep('admin_api_smoke:start')
  await runAdminApiSmoke(publicState.userEmail)
  await logStep('admin_api_smoke:done')
  await logStep('ui_smoke:start')
  await runUiSmoke(publicState)
  await logStep('ui_smoke:done')
  await logStep('admin_bot_actions:start')
  await runAdminBotActions()
  await logStep('admin_bot_actions:done')

  console.log('[smoke] passed')
} finally {
  await logStep('cleanup:start')
  if (browser) {
    await browser.close().catch(() => null)
  }

  await stopChildren()
  await logStep('cleanup:children_stopped')

  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => null)
  await logStep('cleanup:done')
}

async function prepareFixture() {
  const dirs = [
    path.join(runtimeDir, 'downloads', 'atribuicoes', smokeTopicId),
    path.join(runtimeDir, 'screenshots'),
    path.join(runtimeDir, 'subjects', smokeTopicId, 'screenshots'),
    path.join(runtimeDir, 'knowledge', 'catalog'),
    path.join(runtimeDir, 'public-auth'),
    path.join(runtimeDir, 'logs'),
    path.join(runtimeDir, 'jobs'),
  ]
  await Promise.all(dirs.map((dir) => fs.mkdir(dir, { recursive: true })))

  const attachmentPath = path.join(runtimeDir, 'downloads', 'atribuicoes', smokeTopicId, 'smoke-brief.txt')
  const screenshotSourcePath = path.join(runtimeDir, 'screenshots', `${smokeTopicId}.png`)
  const copiedScreenshotPath = path.join(runtimeDir, 'subjects', smokeTopicId, 'screenshots', `${smokeTopicId}.png`)
  const mockTeamsFile = path.join(tempRoot, 'mock-teams-login.html')

  await fs.writeFile(attachmentPath, buildAttachmentText(), 'utf8')
  await fs.writeFile(screenshotSourcePath, onePixelPngBuffer())
  await fs.copyFile(screenshotSourcePath, copiedScreenshotPath)
  await fs.writeFile(mockTeamsFile, buildMockTeamsLoginHtml(), 'utf8')
  await fs.writeFile(path.join(runtimeDir, 'public-auth', 'users.json'), '[]', 'utf8')
  await fs.writeFile(path.join(runtimeDir, 'public-auth', 'sessions.json'), '[]', 'utf8')

  const assignment = {
    id: 'smoke-assignment-1',
    title: smokeTopicTitle,
    dueText: 'Prazo de entrega as 23:59',
    course: '1TIAPF-2026',
    status: 'upcoming',
    detailUrl: 'https://example.invalid/smoke-checkpoint-python',
    downloadedFiles: [attachmentPath],
    screenshotFiles: [screenshotSourcePath],
    localFolder: path.dirname(attachmentPath),
    capturedAt: smokeNow,
  }
  const sourceSignature = JSON.stringify({
    title: assignment.title,
    dueText: assignment.dueText,
    course: assignment.course,
    status: assignment.status,
    detailUrl: assignment.detailUrl,
    downloadedFiles: dedupePaths(assignment.downloadedFiles),
    screenshotFiles: dedupePaths(assignment.screenshotFiles),
    capturedAt: assignment.capturedAt,
  })

  const contentText = buildLongContentText()
  const summary = [
    'Objetivo: concluir o smoke test da atividade de Python.',
    'Entregaveis: relatorio smoke em TXT e checklist final.',
    'Pontos de atencao: revisar formato e validar o arquivo antes do envio.',
  ].join('\n')
  const memory = {
    overview: 'A atividade smoke pede um relatorio curto em TXT com foco no checklist publicado.',
    deliverables: ['Relatorio smoke em TXT', 'Checklist final da entrega'],
    deadlines: [],
    faq: [{ question: 'O que eu preciso enviar?', answer: 'Envie o relatorio smoke em TXT e confirme o checklist final.' }],
    keyFacts: ['O entregavel principal e um relatorio smoke em TXT.', 'A revisao final deve confirmar formato e checklist.'],
    answerStyle: 'Objetivo e pratico.',
    fallbackPolicy: 'Reutilize o resumo e a memoria locais quando o contexto nao mudar.',
    sourceSnippets: ['Arquivo: smoke-brief.txt\nEntregavel principal: relatorio smoke em TXT.'],
  }
  const learning = {
    frequentQuestions: [{ question: 'Qual arquivo devo enviar?', answer: 'O relatorio smoke em TXT e o entregavel principal.' }],
    learningTopics: [{
      title: 'Checklist da entrega',
      explanation: 'Organize a entrega em duas etapas: preparar o texto e validar o checklist final.',
      commonDifficulty: 'A parte mais comum de errar e esquecer a revisao final do formato.',
      studyStrategy: 'Use o resumo salvo como checklist rapido antes de enviar o arquivo.',
    }],
    quickTips: ['Revise o formato final antes de subir o arquivo.'],
  }

  const storedTopic = {
    id: smokeTopicId,
    title: smokeTopicTitle,
    course: assignment.course,
    moduleKey: 'backend',
    status: assignment.status,
    dueText: assignment.dueText,
    detailUrl: assignment.detailUrl,
    assignmentIds: [assignment.id],
    attachments: [{ path: attachmentPath, name: path.basename(attachmentPath) }],
    screenshots: [copiedScreenshotPath],
    contentText,
    summary,
    summaryGeneratedAt: smokeNow,
    agentMemory: memory,
    agentMemoryGeneratedAt: smokeNow,
    learning,
    learningGeneratedAt: smokeNow,
    updatedAt: smokeNow,
    warnings: [],
    sourceSignature,
  }

  await fs.writeFile(path.join(runtimeDir, 'jobs', 'assignments-report.json'), JSON.stringify({
    authStatus: 'login_required',
    liveMeetings: [],
    assignments: [assignment],
    scannedAt: smokeNow,
  }, null, 2), 'utf8')
  await fs.writeFile(path.join(runtimeDir, 'subjects', 'topics.json'), JSON.stringify([storedTopic], null, 2), 'utf8')
  await fs.writeFile(path.join(runtimeDir, 'subjects', smokeTopicId, 'content.txt'), contentText, 'utf8')
  await fs.writeFile(path.join(runtimeDir, 'subjects', smokeTopicId, 'summary.json'), JSON.stringify({ summary, generatedAt: smokeNow }, null, 2), 'utf8')
  await fs.writeFile(path.join(runtimeDir, 'subjects', smokeTopicId, 'memory.json'), JSON.stringify({ memory, generatedAt: smokeNow }, null, 2), 'utf8')
  await fs.writeFile(path.join(runtimeDir, 'subjects', smokeTopicId, 'learning.json'), JSON.stringify({
    learning,
    generatedAt: smokeNow,
    model: 'smoke-cache',
    version: 2,
  }, null, 2), 'utf8')

  await seedPublicChatCache()
  return { mockTeamsUrl: pathToFileURL(mockTeamsFile).href }
}

async function seedPublicChatCache() {
  const topicList = JSON.parse(await fs.readFile(path.join(publishedDir, 'topics.json'), 'utf8'))
  const topicListItem = topicList.find((item) => item.attachmentCount > 0) || topicList[0]
  const topic = JSON.parse(await fs.readFile(path.join(publishedDir, 'topics', `${topicListItem.id}.json`), 'utf8'))
  const chunks = JSON.parse(await fs.readFile(path.join(publishedDir, 'knowledge', 'chunks.json'), 'utf8')).filter((chunk) => chunk.topicId === topic.id)
  const citations = chunks.slice(0, 2).map((chunk) => ({
    sourceType: chunk.sourceType === 'overview' ? 'summary' : chunk.sourceType,
    sourceLabel: `${topic.title} / ${chunk.sourceType}`,
    snippet: chunk.text,
  }))
  const cacheEntry = {
    id: 'smoke-public-cache',
    topicId: topic.id,
    question: publicQuestion,
    questionNormalized: normalizeQuestionForCache(publicQuestion),
    answer: [
      'RESPOSTA DIRETA: Smoke cache answer para validar o chat publico.',
      'O QUE ENTREGAR: - Smoke entregavel principal - Smoke checklist final',
      'ATENCAO: - Smoke revise o formato antes de enviar',
      'PROXIMO PASSO: - Smoke abra o anexo principal e confirme o checklist',
    ].join('\n'),
    sections: {
      summary10s: 'Smoke cache answer para validar o chat publico.',
      fullAnswer: ['Smoke cache answer para validar o chat publico.'],
      deliverables: ['Smoke entregavel principal', 'Smoke checklist final'],
      attentionPoints: ['Smoke revise o formato antes de enviar'],
      nextSteps: ['Smoke abra o anexo principal e confirme o checklist'],
      followUpQuestions: ['Me faca um checklist', 'O que pode me fazer perder pontos?'],
      answerMode: 'grounded',
    },
    confidence: 'high',
    strategyUsed: 'rag_llm',
    providerUsed: 'ollama',
    fallbackLevel: 0,
    citations,
    suggestedQuestions: ['Me faca um checklist', 'O que pode me fazer perder pontos?'],
    nextSteps: ['Smoke abra o anexo principal e confirme o checklist'],
    answeredAt: smokeNow,
    qualityStatus: 'accepted',
    qualityReason: 'Smoke cache entry for public chat.',
    answeredByPass: 'primary',
    model: 'qwen3.5:397b-cloud',
    contentSignature: buildPublicContentSignature(topic, chunks),
    createdAt: smokeNow,
  }
  await fs.writeFile(path.join(runtimeDir, 'knowledge', 'catalog', 'public-exact-answers.json'), JSON.stringify([cacheEntry], null, 2), 'utf8')
}

function startAll(fixture) {
  const sharedEnv = {
    ...process.env,
    FIAPAUTO_DATA_DIR: runtimeDir,
    FIAPAUTO_ADMIN_TOKEN: adminToken,
    FIAPAUTO_BOT_HEADLESS: 'true',
    FIAPAUTO_TEAMS_BASE_URL: fixture.mockTeamsUrl,
    FIAPAUTO_PUBLISHED_SOURCE: 'repo',
  }

  startWorkspace('@fiapauto/public-api', { ...sharedEnv, FIAPAUTO_PUBLIC_API_PORT: String(ports[1]), FIAPAUTO_WEB_ORIGIN: urls.publicWeb })
  startWorkspace('@fiapauto/admin-api', { ...sharedEnv, FIAPAUTO_ADMIN_API_PORT: String(ports[3]), FIAPAUTO_WEB_ORIGIN: urls.adminWebOrigin })
  startWorkspace('@fiapauto/web-public', { ...sharedEnv, FIAPAUTO_PUBLIC_WEB_PORT: String(ports[0]), FIAPAUTO_PUBLIC_API_PORT: String(ports[1]), VITE_PUBLIC_API_BASE_URL: urls.publicApi, VITE_PUBLIC_API_PORT: String(ports[1]) })
  startWorkspace('@fiapauto/web-admin', { ...sharedEnv, FIAPAUTO_ADMIN_WEB_PORT: String(ports[2]), FIAPAUTO_ADMIN_API_PORT: String(ports[3]), VITE_ADMIN_API_BASE_URL: urls.adminApi, VITE_ADMIN_API_PORT: String(ports[3]), VITE_API_BASE_URL: urls.adminApi, VITE_API_PORT: String(ports[3]) })
  startWorkspace('@fiapauto/web-public', { ...sharedEnv, FIAPAUTO_PUBLIC_WEB_PORT: String(ports[4]), FIAPAUTO_PUBLIC_API_PORT: String(deadApiPort), VITE_PUBLIC_API_BASE_URL: `http://127.0.0.1:${deadApiPort}`, VITE_PUBLIC_API_PORT: String(deadApiPort), VITE_PUBLIC_AUTH_MODE: 'none' }, 'public-fallback')
}

async function runPublicApiSmoke() {
  const userEmail = 'smoke.user@example.com'
  const signUp = await requestJson(`${urls.publicApi}/api/public/auth/sign-up`, { method: 'POST', body: { email: userEmail, password: publicPassword } })
  assert.ok(signUp.token)
  assert.equal((await requestJson(`${urls.publicApi}/api/public/auth/me`, { headers: { Authorization: `Bearer ${signUp.token}` } })).email, userEmail)
  assert.equal((await requestJson(`${urls.publicApi}/api/public/auth/ping`, { method: 'POST', headers: { Authorization: `Bearer ${signUp.token}` } })).ok, true)
  assert.equal((await requestJson(`${urls.publicApi}/api/public/auth/sign-out`, { method: 'POST', headers: { Authorization: `Bearer ${signUp.token}` } })).ok, true)
  assert.ok((await requestJson(`${urls.publicApi}/api/public/auth/sign-in`, { method: 'POST', body: { email: userEmail, password: publicPassword } })).token)
  assert.equal((await requestJson(`${urls.publicApi}/api/public/auth/guest`, { method: 'POST' })).isGuest, true)
  assert.equal(typeof (await requestJson(`${urls.publicApi}/api/public/manifest`)).releaseId, 'string')

  const topicList = await requestJson(`${urls.publicApi}/api/public/topics`)
  const topicId = topicList.topics[0].id
  const topic = await requestJson(`${urls.publicApi}/api/public/topics/${encodeURIComponent(topicId)}`)
  const assetKey = topic.attachments[0]?.key || topic.attachments[0]?.path || topic.screenshots[0]
  const assetResponse = await fetch(`${urls.publicApi}/api/public/assets?key=${encodeURIComponent(assetKey)}`)
  assert.equal(assetResponse.ok, true)
  assert.ok((await requestJson(`${urls.publicApi}/api/public/sync/status`)).hasOwnProperty('inSync'))

  const chat = await requestJson(`${urls.publicApi}/api/public/chat/topic`, { method: 'POST', body: { topicId, question: publicQuestion } })
  assert.equal(chat.answeredByPass, 'cache')
  assert.match(chat.answer, /Smoke cache answer/i)

  return { userEmail, publicTopicTitle: topic.title }
}

async function runAdminApiSmoke(userEmail) {
  assert.equal((await requestJson(`${urls.adminApi}/api/health`)).adminProtectionEnabled, true)
  const status = await requestJson(`${urls.adminApi}/api/bot/status`, { headers: adminHeaders() })
  assert.ok(status.topics.some((topic) => topic.id === smokeTopicId))
  assert.equal((await requestJson(`${urls.adminApi}/api/topics/${encodeURIComponent(smokeTopicId)}`)).id, smokeTopicId)
  assert.match((await requestJson(`${urls.adminApi}/api/topics/${encodeURIComponent(smokeTopicId)}/generate-summary`, { method: 'POST', headers: adminHeaders({ 'Content-Type': 'application/json' }), body: { force: false } })).summary, /smoke test/i)
  assert.equal((await requestJson(`${urls.adminApi}/api/topics/${encodeURIComponent(smokeTopicId)}/generate-memory`, { method: 'POST', headers: adminHeaders({ 'Content-Type': 'application/json' }), body: { force: false } })).memory.deliverables[0], 'Relatorio smoke em TXT')
  assert.ok((await requestJson(`${urls.adminApi}/api/public/auth/users`, { headers: adminHeaders() })).users.some((user) => user.email === userEmail))
  assert.ok((await requestJson(`${urls.adminApi}/api/public/monitor/status`, { headers: adminHeaders() })).traffic.totalRecentRequests >= 1)
}

async function runUiSmoke(publicState) {
  browser = await chromium.launch({ headless: true })

  const publicPage = await (await browser.newContext()).newPage()
  await publicPage.goto(urls.publicWeb, { waitUntil: 'networkidle' })
  await publicPage.getByRole('button', { name: /Entrar como visitante/i }).click()
  await publicPage.waitForFunction(() => document.body.innerText.includes('Assistente de Estudos'))
  await publicPage.locator('textarea').fill(publicQuestion)
  await publicPage.getByRole('button', { name: /Perguntar ao agente/i }).click()
  await publicPage.waitForFunction(() => document.body.innerText.includes('Smoke cache answer para validar o chat publico.'))

  const fallbackPage = await (await browser.newContext()).newPage()
  await fallbackPage.goto(urls.publicFallbackWeb, { waitUntil: 'networkidle' })
  await fallbackPage.waitForFunction(() => document.body.innerText.includes('Assistente de Estudos'))
  await fallbackPage.waitForFunction((title) => document.body.innerText.includes(title), publicState.publicTopicTitle)

  const adminPage = await (await browser.newContext()).newPage()
  await adminPage.goto(urls.adminWeb, { waitUntil: 'networkidle' })
  await adminPage.waitForFunction(() => document.body.innerText.includes('Painel protegido por token'))
  await adminPage.locator('#admin-token').fill(adminToken)
  await adminPage.getByRole('button', { name: /Entrar no admin/i }).click()
  await adminPage.waitForFunction(() => document.body.innerText.includes('Bot de gravacao, transcricao e topicos'))
  await adminPage.waitForFunction(() => document.body.innerText.includes('Conectada'))
  await adminPage.getByRole('button', { name: /Trabalhos/i }).click()
  await adminPage.waitForFunction((title) => document.body.innerText.includes(title) && document.body.innerText.includes('Resumo persistido'), smokeTopicTitle)
}

async function runAdminBotActions() {
  assert.equal((await requestJson(`${urls.adminApi}/api/bot/session`, { method: 'POST', headers: adminHeaders() })).workspaceReport.authStatus, 'login_required')
  assert.equal((await requestJson(`${urls.adminApi}/api/bot/test`, { method: 'POST', headers: adminHeaders() })).executedJobs, 0)
  assert.ok(Array.isArray((await requestJson(`${urls.adminApi}/api/bot/reset`, { method: 'POST', headers: adminHeaders() })).jobs))
}

function adminHeaders(extra = {}) {
  return { 'X-FIAPAUTO-Admin-Token': adminToken, ...extra }
}

function startWorkspace(workspace, env, label = workspace) {
  const child = process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/s', '/c', `npm run dev -w ${workspace}`], { cwd: rootDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('npm', ['run', 'dev', '-w', workspace], { cwd: rootDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => process.stdout.write(`[${label}] ${chunk}`))
  child.stderr.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk}`))
  children.push(child)
}

async function stopChildren() {
  await Promise.all(children.map((child) => stopChild(child)))
}

async function stopChild(child) {
  const pid = child.pid
  if (child.exitCode !== null) {
    child.stdout?.destroy()
    child.stderr?.destroy()
    return
  }

  if (process.platform === 'win32' && pid) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        cwd: rootDir,
        stdio: 'ignore',
      })
      killer.once('exit', () => resolve(undefined))
    })
    await waitForPidExit(pid, 5000)
    child.stdout?.destroy()
    child.stderr?.destroy()
    return
  }

  child.kill('SIGKILL')
  await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(undefined))),
    delay(3000),
  ])
  child.stdout?.destroy()
  child.stderr?.destroy()
}

async function ensureChromiumInstalled() {
  try {
    const probe = await chromium.launch({ headless: true })
    await probe.close()
    return
  } catch (error) {
    if (!(error instanceof Error) || !/Executable doesn't exist|browserType.launch/i.test(error.message)) {
      throw error
    }
  }

  await new Promise((resolve, reject) => {
    const child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', 'npx playwright install chromium'], { cwd: rootDir, env: process.env, stdio: 'inherit' })
      : spawn('npx', ['playwright', 'install', 'chromium'], { cwd: rootDir, env: process.env, stdio: 'inherit' })
    child.once('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`playwright_install_failed:${code ?? 'unknown'}`))))
  })
}

async function waitForHttp(url, timeoutMs = 60_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await delay(500)
  }
  throw new Error(`wait_for_http_failed:${url}`)
}

async function waitForJson(url, predicate, timeoutMs = 60_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        const payload = await response.json()
        if (!predicate || predicate(payload)) return payload
      }
    } catch {}
    await delay(500)
  }
  throw new Error(`wait_for_json_failed:${url}`)
}

async function requestJson(url, options = {}) {
  const headers = new Headers(options.headers || {})
  let body = options.body
  if (body && typeof body === 'object' && typeof body !== 'string') {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(body)
  }
  const response = await fetch(url, { method: options.method || 'GET', headers, body })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${url} -> ${response.status} ${JSON.stringify(payload)}`)
  return payload
}

async function reservePorts(preferredPorts) {
  const used = new Set()
  const results = []
  for (const preferredPort of preferredPorts) {
    for (let port = preferredPort; port < preferredPort + 200; port += 1) {
      if (used.has(port)) continue
      if (await isPortFree(port)) {
        used.add(port)
        results.push(port)
        break
      }
    }
  }
  return results
}

async function isPortFree(port) {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen({ host: '127.0.0.1', port })
  })
}

function buildAttachmentText() {
  return ['Checkpoint smoke da materia de Python.', 'Entregavel principal: relatorio smoke em TXT.', 'Checklist: revisar formato, validar conteudo, enviar arquivo final.', '', buildLongContentText()].join('\n')
}

function buildLongContentText() {
  return Array.from({ length: 18 }, (_, index) => `Bloco ${index + 1}: confirme o relatorio smoke em TXT, revise o checklist final e valide o formato antes do envio.`).join('\n\n')
}

function buildMockTeamsLoginHtml() {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Smoke Teams Login</title></head><body><h1>Smoke Teams Login</h1><input type="email" name="loginfmt" value="" /></body></html>'
}

function onePixelPngBuffer() {
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5nR8sAAAAASUVORK5CYII=', 'base64')
}

function slugify(value) {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function dedupePaths(values) {
  return [...new Set(values.map((value) => path.resolve(value)))]
}

function normalizeQuestionForCache(value) {
  return normalizeText(value).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
}

function buildPublicContentSignature(topic, chunks) {
  const hash = createHash('sha1')
  hash.update(topic.id)
  hash.update('|')
  hash.update(topic.updatedAt ?? '')
  hash.update('|')
  for (const chunk of chunks.slice().sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update(chunk.id)
    hash.update('|')
    hash.update(chunk.capturedAt)
    hash.update('|')
    hash.update(chunk.text)
    hash.update('\n')
  }
  return hash.digest('hex')
}

function normalizeText(value) {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForPidExit(pid, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (!isPidRunning(pid)) {
      return
    }
    await delay(100)
  }
}

function isPidRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function resetProgressLog() {
  await fs.mkdir(path.dirname(progressFile), { recursive: true })
  await fs.writeFile(progressFile, '', 'utf8')
}

async function logStep(step) {
  await fs.appendFile(progressFile, `${new Date().toISOString()} ${step}\n`, 'utf8')
}

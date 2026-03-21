import { useEffect, useEffectEvent, useMemo, useState } from 'react'
import {
  askTopicAssistant,
  connectTeamsSession,
  emptyBotState,
  fetchBotStatus,
  fetchTopic,
  fetchTopicDebug,
  generateTopicMemory,
  generateTopicSummary,
  resetBotDemo,
  runBotDemo,
  syncReadyLessonsIntoWorkspace,
  type BotState,
  type SubjectTopic,
  buildBotFileUrl,
  type TopicAskResult,
  type TopicSummaryResult,
} from './api/botApi.ts'
import { askPublicTopic, buildPublicAssetUrl, fetchPublicTopic, fetchPublicTopics } from './api/publicApi.ts'
import { initialWorkspaceState } from './state/demoData.ts'
import { loadWorkspaceState, resetWorkspaceState, saveWorkspaceState } from './state/storage.ts'
import type { WorkspaceState } from './types.ts'
import type { PublicTopic, PublicTopicListItem } from '@fiapauto/backend/contracts'

export function useWorkspaceController(appMode: 'admin' | 'user') {
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => loadWorkspaceState())
  const [botState, setBotState] = useState<BotState>(emptyBotState)
  const [selectedLessonId, setSelectedLessonId] = useState(
    () => loadWorkspaceState().lessons[0]?.id ?? initialWorkspaceState.lessons[0]?.id ?? '',
  )
  const [selectedTopicId, setSelectedTopicId] = useState('')
  const [selectedTopic, setSelectedTopic] = useState<SubjectTopic | null>(null)
  const [topicSummary, setTopicSummary] = useState<TopicSummaryResult | null>(null)
  const [topicAnswer, setTopicAnswer] = useState<TopicAskResult | null>(null)
  const [topicQuestion, setTopicQuestion] = useState('')
  const [topicDebugEvents, setTopicDebugEvents] = useState<BotState['llmDebug']['events']>([])
  const [activity, setActivity] = useState(
    appMode === 'admin' ? 'Painel operacional pronto para testar o bot' : 'Site publico carregado para consulta de materias',
  )
  const [botBusy, setBotBusy] = useState<'connect' | 'load' | 'test' | 'reset' | null>(null)
  const [topicBusy, setTopicBusy] = useState<'summary' | 'memory' | 'ask' | 'detail' | null>(null)
  const [activeTab, setActiveTab] = useState<'aulas' | 'trabalhos' | 'aprendizado'>(
    appMode === 'admin' ? 'aulas' : 'trabalhos',
  )
  const refreshBotStatusEvent = useEffectEvent((showMessage = false) => {
    void refreshBotStatus(showMessage)
  })

  useEffect(() => {
    saveWorkspaceState(workspace)
  }, [workspace])

  useEffect(() => {
    if (appMode === 'admin') {
      refreshBotStatusEvent(false)
      return
    }

    void loadTopics(false)
  }, [appMode, refreshBotStatusEvent])

  useEffect(() => {
    if (appMode !== 'admin' || botState.authStatus === 'authenticated') return
    const timer = window.setInterval(() => refreshBotStatusEvent(false), 5000)
    return () => window.clearInterval(timer)
  }, [appMode, botState.authStatus, refreshBotStatusEvent])

  useEffect(() => {
    if (!workspace.lessons.find((lesson) => lesson.id === selectedLessonId)) {
      setSelectedLessonId(workspace.lessons[0]?.id ?? '')
    }
  }, [selectedLessonId, workspace.lessons])

  useEffect(() => {
    if (!botState.topics.find((topic) => topic.id === selectedTopicId)) {
      setSelectedTopicId(botState.topics[0]?.id ?? '')
    }
  }, [botState.topics, selectedTopicId])

  useEffect(() => {
    if (!selectedTopicId) {
      setSelectedTopic(null)
      setTopicDebugEvents([])
      return
    }

    void loadTopicDetail(selectedTopicId)
  }, [selectedTopicId, appMode])

  const importedLessons = useMemo(
    () => workspace.lessons.filter((lesson) => lesson.notes.includes('Importado automaticamente pelo bot do Teams')),
    [workspace.lessons],
  )
  const selectedLesson = useMemo(
    () => importedLessons.find((lesson) => lesson.id === selectedLessonId) ?? importedLessons[0] ?? null,
    [importedLessons, selectedLessonId],
  )
  const selectedTranscript = useMemo(
    () => workspace.transcripts.find((transcript) => transcript.lessonId === selectedLesson?.id) ?? null,
    [selectedLesson?.id, workspace.transcripts],
  )
  const selectedTopicListItem = useMemo(
    () => botState.topics.find((topic) => topic.id === selectedTopicId) ?? botState.topics[0] ?? null,
    [botState.topics, selectedTopicId],
  )

  async function loadTopics(showMessage = true) {
    try {
      const topics = await fetchPublicTopics()

      setBotState((current) => ({
        ...current,
        topics: topics.topics.map(mapPublishedTopicListToTopic),
        apiConnected: true,
      }))

      if (!selectedTopicId && topics.topics[0]) {
        setSelectedTopicId(topics.topics[0].id)
      }

      if (showMessage) {
        setActivity('Materias publicas atualizadas.')
      }
    } catch {
      setBotState((current) => ({ ...current, apiConnected: false }))
      if (showMessage) {
        setActivity('Nao foi possivel carregar as materias publicas agora.')
      }
    }
  }

  async function refreshBotStatus(
    showMessage = true,
    options?: {
      preserveTopicSummary?: boolean
      preserveTopicAnswer?: boolean
    },
  ) {
    setBotBusy('load')
    try {
      const data = await fetchBotStatus()
      setBotState(mapBotState(data))
      setWorkspace((current) => syncReadyLessonsIntoWorkspace(current, data.readyLessons))
      if (!options?.preserveTopicSummary) {
        setTopicSummary(null)
      }
      if (!options?.preserveTopicAnswer) {
        setTopicAnswer(null)
      }
      if (data.readyLessons[0]) setSelectedLessonId(data.readyLessons[0].lessonId)
      if (!selectedTopicId && data.topics[0]) setSelectedTopicId(data.topics[0].id)
      if (showMessage) setActivity('Status do bot atualizado')
    } catch {
      setBotState((current) => ({ ...current, apiConnected: false }))
      if (showMessage) setActivity('API admin nao respondeu ou o token do painel nao e valido.')
    } finally {
      setBotBusy(null)
    }
  }

  async function runBotFromSite() {
    setBotBusy('test')
    try {
      const data = await runBotDemo()
      setBotState(mapBotState(data))
      setWorkspace((current) => syncReadyLessonsIntoWorkspace(current, data.readyLessons))
      setTopicSummary(null)
      setTopicAnswer(null)
      if (data.readyLessons[0]) setSelectedLessonId(data.readyLessons[0].lessonId)
      if (data.topics[0]) setSelectedTopicId(data.topics[0].id)
      if (data.runtimeError) {
        setActivity(explainRuntimeError(data.runtimeError))
        return
      }
      if (data.workspaceReport.authStatus !== 'authenticated') {
        setActivity('Teams precisa de login. Use "Conectar Teams" para salvar a sessao e tente novamente.')
        return
      }
      if (data.executedJobs > 0) {
        setActivity(`Bot executado: ${data.executedJobs} aula(s) ao vivo processada(s).`)
        return
      }
      setActivity('Varredura concluida. Materias e trabalhos foram atualizados no workspace de topicos.')
    } catch (error) {
      if (error instanceof Error && error.message === 'scan_in_progress') {
        const payload = (error as Error & { payload?: Parameters<typeof mapBotState>[0] }).payload
        if (payload) setBotState(mapBotState(payload))
        setActivity('O bot ja esta executando uma varredura. Aguarde alguns segundos e atualize o status.')
        return
      }
      setActivity('Falha ao executar o bot pelo site.')
    } finally {
      setBotBusy(null)
    }
  }

  async function connectTeams() {
    setBotBusy('connect')
    try {
      const data = await connectTeamsSession()
      setBotState(mapBotState(data))
      setTopicSummary(null)
      setTopicAnswer(null)
      if (data.runtimeError) {
        setActivity(explainRuntimeError(data.runtimeError))
        return
      }
      setActivity(data.connected ? 'Sessao do Teams confirmada.' : 'A janela do Teams foi aberta para concluir o login.')
    } catch {
      setActivity('Falha ao abrir a sessao do Teams.')
    } finally {
      setBotBusy(null)
    }
  }

  async function resetAll() {
    setBotBusy('reset')
    try {
      const data = await resetBotDemo()
      setBotState(mapBotState(data))
      setTopicSummary(null)
      setTopicAnswer(null)
      setSelectedTopic(null)
      setTopicDebugEvents([])
      const state = resetWorkspaceState()
      setWorkspace(state)
      setSelectedLessonId(state.lessons[0]?.id ?? '')
      setSelectedTopicId('')
      setActivity('Demo resetada. O bot esta pronto para um novo teste.')
    } catch {
      setActivity('Falha ao resetar a demo.')
    } finally {
      setBotBusy(null)
    }
  }

  async function loadTopicDetail(topicId: string) {
    setTopicBusy('detail')
    try {
      const topic = appMode === 'admin' ? await fetchTopic(topicId) : mapPublishedTopicToTopic(await fetchPublicTopic(topicId))
      setSelectedTopic(topic)
      setTopicSummary(
        topic.summary
          ? {
              topicId: topic.id,
              moduleKey: topic.moduleKey,
              summary: topic.summary,
              warnings: topic.warnings,
              filesUsed: topic.attachments.map((item) => item.path),
              generatedAt: topic.summaryGeneratedAt || topic.updatedAt,
            }
          : null,
      )

      if (appMode === 'admin') {
        try {
          const debug = await fetchTopicDebug(topicId)
          setTopicDebugEvents(debug.events)
        } catch {
          setTopicDebugEvents([])
        }
      } else {
        setTopicDebugEvents([])
      }
    } catch {
      setActivity('Falha ao carregar os detalhes do topico selecionado.')
    } finally {
      setTopicBusy(null)
    }
  }

  async function handleGenerateSummary(force = false) {
    if (!selectedTopicListItem) return
    setTopicBusy('summary')
    try {
      const result = await generateTopicSummary(selectedTopicListItem.id, force)
      setTopicSummary(result)
      await loadTopicDetail(selectedTopicListItem.id)
      await refreshBotStatus(false)
      setActivity(`Resumo persistido para a materia ${selectedTopicListItem.title}.`)
    } catch {
      setActivity('Falha ao gerar o resumo persistido do topico.')
    } finally {
      setTopicBusy(null)
    }
  }

  async function handleGenerateMemory(force = false) {
    if (!selectedTopicListItem) return
    setTopicBusy('memory')
    try {
      await generateTopicMemory(selectedTopicListItem.id, force)
      await loadTopicDetail(selectedTopicListItem.id)
      await refreshBotStatus(false)
      setActivity(`Memoria do agente atualizada para a materia ${selectedTopicListItem.title}.`)
    } catch {
      setActivity('Falha ao gerar a memoria persistida do agente.')
    } finally {
      setTopicBusy(null)
    }
  }

  async function handleAskTopic() {
    const question = topicQuestion.trim()
    if (!question || !selectedTopicListItem) {
      setActivity('Digite uma pergunta e selecione uma materia antes de consultar o agente.')
      return
    }
    setTopicBusy('ask')
    try {
      const result = appMode === 'admin'
        ? await askTopicAssistant({ topicId: selectedTopicListItem.id, question })
        : normalizePublicChatResult(await askPublicTopic({ topicId: selectedTopicListItem.id, question }), selectedTopicListItem.moduleKey)
      setTopicAnswer(result)
      await loadTopicDetail(selectedTopicListItem.id)
      if (appMode === 'admin') {
        await refreshBotStatus(false, {
          preserveTopicSummary: true,
          preserveTopicAnswer: true,
        })
      } else {
        await loadTopics(false)
      }
      if (result.strategyUsed === 'memory') {
        setActivity('Resposta entregue pela memoria persistida do topico.')
      } else if (result.strategyUsed === 'deterministic') {
        setActivity('Resposta entregue pelo fallback guiado do assistente.')
      } else if (result.strategyUsed === 'provider_fallback') {
        setActivity('Resposta entregue por um provedor alternativo do assistente.')
      } else {
        setActivity('Resposta contextual gerada pelo assistente com base no topico.')
      }
    } catch {
      setActivity('Falha ao perguntar ao agente da materia.')
    } finally {
      setTopicBusy(null)
    }
  }

  return {
    workspace,
    setWorkspace,
    botState,
    selectedLessonId,
    setSelectedLessonId,
    selectedTopicId,
    setSelectedTopicId,
    selectedTopic,
    topicSummary,
    topicAnswer,
    topicQuestion,
    setTopicQuestion,
    topicDebugEvents,
    activity,
    setActivity,
    botBusy,
    topicBusy,
    activeTab,
    setActiveTab,
    viewMode: appMode,
    importedLessons,
    selectedLesson,
    selectedTranscript,
    refreshBotStatus,
    runBotFromSite,
    connectTeams,
    resetAll,
    handleGenerateSummary,
    handleGenerateMemory,
    handleAskTopic,
    loadTopics,
    buildAssetUrl: (asset: string | { path?: string; key?: string; publicUrl?: string }) => {
      const rawValue = typeof asset === 'string' ? asset : asset.publicUrl || asset.key || asset.path || ''
      return appMode === 'admin' ? buildBotFileUrl(rawValue) : buildPublicAssetUrl(rawValue)
    },
  }
}

export type WorkspaceController = ReturnType<typeof useWorkspaceController>

export function mapBotState(data: {
  jobs: BotState['jobs']
  readyLessons: BotState['readyLessons']
  workspaceReport: {
    authStatus: BotState['authStatus']
    liveMeetings: BotState['liveMeetings']
    assignments: BotState['assignments']
    scannedAt: string
  }
  topics: BotState['topics']
  logs: string[]
  llm?: BotState['llm']
  llmDebug?: BotState['llmDebug']
  runtimeError?: string
}) {
  return {
    jobs: data.jobs,
    readyLessons: data.readyLessons,
    liveMeetings: data.workspaceReport.liveMeetings,
    assignments: data.workspaceReport.assignments,
    topics: data.topics,
    logs: data.logs,
    authStatus: data.workspaceReport.authStatus,
    scannedAt: data.workspaceReport.scannedAt,
    apiConnected: true,
    llm: data.llm ?? emptyBotState.llm,
    llmDebug: data.llmDebug ?? emptyBotState.llmDebug,
    runtimeError: data.runtimeError ?? '',
  } satisfies BotState
}

export function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

export function compactTopicItems(items: string[] | undefined, limit = 3) {
  return (items ?? [])
    .map(cleanTopicDisplayText)
    .filter(Boolean)
    .map((item) => truncateText(item, 140))
    .slice(0, limit)
}

export function truncateText(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trim()}...`
}

export function explainRuntimeError(error: string) {
  if (error === 'teams_login_required') return 'O Teams ainda nao esta autenticado. Clique em "Conectar Teams", conclua o login e tente novamente.'
  if (error === 'teams_browser_closed') return 'A janela do Teams foi fechada durante a automacao. Reabra com "Conectar Teams" e tente novamente.'
  if (error === 'assignments_view_not_loaded') return 'O bot abriu o Teams, mas nao conseguiu confirmar a tela de Atribuicoes.'
  return `Falha na automacao: ${error}`
}

export function safeJson(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function cleanTopicDisplayText(value: string) {
  return value
    .replace(/Arquivo:\s*/gi, '')
    .replace(/Checkpoint\s*1\.docx\.pdf/gi, '')
    .replace(/\bPARTE\s+[IVX]+\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*;\s*/g, '; ')
    .trim()
}

export function extractSummarySections(summary: string | undefined) {
  const seenLabels = new Set<string>()
  const sections: Array<{ label: string; text: string }> = []
  for (const rawLine of (summary ?? '').split(/\n+/)) {
    const line = cleanTopicDisplayText(rawLine)
    const match = line.match(/^([^:]{3,30}):\s*(.+)$/)
    if (!match) {
      continue
    }

    const label = match[1]!.trim()
    const normalizedLabel = label.toLowerCase()
    if (/^(status|link de detalhe|modulo sugerido|arquivos baixados)$/i.test(label)) {
      continue
    }

    if (seenLabels.has(normalizedLabel)) {
      continue
    }

    const text = normalizeSummarySectionText(label, match[2]!.trim())
    if (!text) {
      continue
    }

    seenLabels.add(normalizedLabel)
    sections.push({ label, text })
  }

  return sections
}

export function buildUserDeliverables(input: {
  summary?: string
  attachmentNames?: string[]
  memoryDeliverables?: string[]
}) {
  const fromSummary = extractDeliverablesFromSummary(input.summary)
  if (fromSummary.length > 0) {
    return fromSummary
  }

  const fromMemory = compactTopicItems(input.memoryDeliverables, 8)
    .map((item) => normalizeDeliverableText(item))
    .filter(isUsefulDeliverable)

  if (fromMemory.length > 0) {
    return dedupeDisplayItems(fromMemory).slice(0, 4)
  }

  const fromAttachments = (input.attachmentNames ?? [])
    .map((item) => normalizeAttachmentName(item))
    .filter(isUsefulDeliverable)

  return dedupeDisplayItems(fromAttachments).slice(0, 3)
}

export function formatDisplayDateOnly(...values: Array<string | undefined>) {
  for (const value of values) {
    const normalized = (value ?? '').trim()
    if (!normalized) {
      continue
    }

    const numeric = normalized.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/)
    if (numeric) {
      const [, day, month, year] = numeric
      const fullYear = year!.length === 2 ? `20${year}` : year!
      return `${day!.padStart(2, '0')}/${month!.padStart(2, '0')}/${fullYear}`
    }
  }

  return 'Data nao identificada no material.'
}

function dedupeDisplayItems(values: string[]) {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = value.toLowerCase()
    if (!key || seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}

function normalizeSummarySectionText(label: string, value: string) {
  if (/prazo/i.test(label)) {
    return formatDisplayDateOnly(value)
  }

  return cleanTopicDisplayText(value)
    .replace(/^Prazo de entrega Ã s?\s*/i, '')
    .replace(/^Prazo de entrega\s*/i, '')
    .replace(/^Titulo:\s*/i, '')
    .trim()
}

function normalizeDeliverableText(value: string) {
  const cleaned = cleanTopicDisplayText(value)
    .replace(/^[a-z0-9]+\)\s*/i, '')
    .replace(/^Titulo:\s*/i, '')
    .replace(/^Arquivo\s*"?/i, '')
    .replace(/"?$/i, '')
    .replace(/\b(curso|status|prazo|link de detalhe|modulo sugerido|arquivos baixados)\b.*$/i, '')
    .replace(/\.pdf$/i, ' PDF')
    .replace(/\.docx$/i, '')
    .replace(/\.xlsx$/i, ' Excel')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (/apresent/i.test(cleaned) && /pdf/i.test(cleaned)) {
    return 'Apresentacao em PDF'
  }

  if (/(formular|formulÃ¡rio|formulario|pesquisa)/i.test(cleaned) && /pdf/i.test(cleaned)) {
    return 'Formulario ou pesquisa em PDF'
  }

  if (/(base de dados|planilha|excel|xlsx)/i.test(cleaned)) {
    return 'Base de dados em Excel'
  }

  return cleaned
}

function normalizeAttachmentName(value: string) {
  const normalized = value
    .replace(/\.(pdf|docx|xlsx|xls)$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()

  if (/checkpoint\s*\d+|fiap|atividade|aula/i.test(normalized)) {
    return ''
  }

  return normalized
}

function extractDeliverablesFromSummary(summary: string | undefined) {
  const deliverablesText = extractSummarySections(summary)
    .find((item) => /entreg/i.test(item.label))
    ?.text

  if (!deliverablesText) {
    return []
  }

  const heuristics = buildDeliverablesFromHeuristics(deliverablesText)
  if (heuristics.length > 0) {
    return heuristics
  }

  return dedupeDisplayItems(
    deliverablesText
      .split(/\s*;\s*|\s*,\s*|\s+ e \s+/i)
      .map((item) => normalizeDeliverableText(item))
      .filter(isUsefulDeliverable),
  ).slice(0, 4)
}

function isUsefulDeliverable(value: string) {
  const normalized = value.trim()
  if (normalized.length < 4 || normalized.length > 60) {
    return false
  }

  if (
    /(disciplina|professor|semestre|curso|status|prazo|teams\.microsoft|rodolfo|checkpoint|tecnologo|inteligencia artificial|\.docx|\.pdf|\.xlsx)/i.test(
      normalized,
    )
  ) {
    return false
  }

  const words = normalized.split(/\s+/)
  if (words.length > 8) {
    return false
  }

  return true
}

function buildDeliverablesFromHeuristics(value: string) {
  const normalized = cleanTopicDisplayText(value).toLowerCase()
  const items: string[] = []

  if (/(apresent|slide)/i.test(normalized) && /pdf/i.test(normalized)) {
    items.push('Apresentacao em PDF')
  }

  if (/(formular|formulÃ¡rio|formulario|pesquisa)/i.test(normalized) && /pdf/i.test(normalized)) {
    items.push('Formulario ou pesquisa em PDF')
  }

  if (/(base de dados|planilha|excel|xlsx)/i.test(normalized)) {
    items.push('Base de dados em Excel')
  }

  return dedupeDisplayItems(items)
}

function mapPublishedTopicListToTopic(topic: PublicTopicListItem): SubjectTopic {
  return {
    id: topic.id,
    title: topic.title,
    course: topic.course,
    moduleKey: topic.moduleKey,
    status: topic.status,
    dueText: topic.dueText,
    detailUrl: undefined,
    assignmentIds: [],
    attachments: [],
    screenshots: [],
    contentText: '',
    summary: topic.summary,
    summaryGeneratedAt: topic.summaryGeneratedAt,
    agentMemory: null,
    agentMemoryGeneratedAt: undefined,
    learning: null,
    learningGeneratedAt: undefined,
    updatedAt: topic.updatedAt,
    warnings: [],
  }
}

function mapPublishedTopicToTopic(topic: PublicTopic): SubjectTopic {
  return {
    id: topic.id,
    title: topic.title,
    course: topic.course,
    moduleKey: topic.moduleKey,
    status: topic.status,
    dueText: topic.dueText,
    detailUrl: undefined,
    assignmentIds: [],
    attachments: topic.attachments.map((attachment) => ({
      ...attachment,
      path: attachment.key || attachment.path,
    })),
    screenshots: topic.screenshots,
    contentText: '',
    summary: topic.summary,
    summaryGeneratedAt: topic.summaryGeneratedAt,
    agentMemory: topic.agentMemory,
    agentMemoryGeneratedAt: undefined,
    learning: topic.learning,
    learningGeneratedAt: undefined,
    updatedAt: topic.updatedAt,
    warnings: [],
  }
}

function normalizePublicChatResult(
  payload: Awaited<ReturnType<typeof askPublicTopic>>,
  moduleKey: string,
): TopicAskResult {
  return {
    topicId: payload.topicId,
    answer: payload.answer,
    moduleKey,
    warnings: [],
    usedFallback: false,
    answeredAt: payload.answeredAt,
    confidence: payload.confidence,
    strategyUsed: payload.strategyUsed === 'memory' ? 'memory' : 'deterministic',
    providerUsed: 'local',
    fallbackLevel: 0,
    citations: payload.citations,
    suggestedQuestions: payload.suggestedQuestions,
    nextSteps: payload.nextSteps,
  }
}

import type {
  BotJob,
  BotStatusPayload,
  LibraryMatch,
  LiveMeeting,
  LlmDebugEvent,
  LlmStatus,
  ReadyLesson,
  SubjectTopic,
  TopicDebugResult,
  TopicAgentMemory,
  TopicAskResult,
  TopicLearning,
  TopicSummaryResult,
  ValidatedAnswerEntry,
} from '@fiapauto/backend/contracts'
import type { Lesson, WorkspaceState } from '../types.ts'

const BOT_API_PORT = (import.meta.env.VITE_API_PORT?.trim() || import.meta.env.VITE_PUBLIC_API_PORT?.trim() || '')
const BOT_API_BASE = (resolveBotApiBase() ?? '').replace(/\/+$/, '')
const ADMIN_TOKEN_STORAGE_KEY = 'fiapauto.admin-token.v1'

function buildApiUrl(path: string) {
  return BOT_API_BASE ? `${BOT_API_BASE}${path}` : path
}

function resolveBotApiBase() {
  const runtimeLocalBase = resolveRuntimeLocalApiBase()
  if (runtimeLocalBase) {
    return runtimeLocalBase
  }

  return import.meta.env.VITE_API_BASE_URL ?? ''
}

function resolveRuntimeLocalApiBase() {
  if (typeof window === 'undefined' || !BOT_API_PORT) {
    return ''
  }

  const hostname = window.location.hostname?.trim()
  if (!hostname) {
    return ''
  }

  if (!/^(127\.0\.0\.1|localhost|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})$/i.test(hostname)) {
    return ''
  }

  return `${window.location.protocol}//${hostname}:${BOT_API_PORT}`
}

function buildAdminHeaders(init?: HeadersInit) {
  const token = getStoredAdminToken()
  const headers = new Headers(init)

  if (token) {
    headers.set('X-FIAPAUTO-Admin-Token', token)
  }

  return headers
}

export type {
  BotJob,
  LibraryMatch,
  LiveMeeting,
  LlmDebugEvent,
  LlmStatus,
  ReadyLesson,
  SubjectTopic,
  TopicDebugResult,
  TopicAgentMemory,
  TopicAskResult,
  TopicLearning,
  TopicSummaryResult,
  ValidatedAnswerEntry,
}

export type BotState = {
  jobs: BotJob[]
  readyLessons: ReadyLesson[]
  liveMeetings: LiveMeeting[]
  assignments: BotStatusPayload['workspaceReport']['assignments']
  topics: SubjectTopic[]
  logs: string[]
  authStatus: 'authenticated' | 'login_required'
  scannedAt: string
  apiConnected: boolean
  llm: LlmStatus
  llmDebug: {
    historyFile: string
    maxTextChars: number
    events: LlmDebugEvent[]
  }
  runtimeError?: string
}

export const emptyBotState: BotState = {
  jobs: [],
  readyLessons: [],
  liveMeetings: [],
  assignments: [],
  topics: [],
  logs: [],
  authStatus: 'login_required',
  scannedAt: '',
  apiConnected: false,
  llm: {
    baseUrl: '',
    model: '',
    enabled: false,
    hasApiKey: false,
  },
  llmDebug: {
    historyFile: '',
    maxTextChars: 0,
    events: [],
  },
  runtimeError: '',
}

export function normalizeLessonTitle(title: string) {
  return title.replace(/^Teams Demo -\s*/, '').trim()
}

export async function fetchBotStatus() {
  const response = await fetch(buildApiUrl('/api/bot/status'), {
    headers: buildAdminHeaders(),
  })
  if (!response.ok) {
    throw new Error('bot_status_failed')
  }

  return (await response.json()) as BotStatusPayload
}

export async function runBotDemo() {
  const response = await fetch(buildApiUrl('/api/bot/test'), {
    method: 'POST',
    headers: buildAdminHeaders(),
  })
  if (!response.ok) {
    if (response.status === 409) {
      const payload = (await response.json()) as { error: 'scan_in_progress' } & BotStatusPayload
      throw Object.assign(new Error('scan_in_progress'), { payload })
    }

    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(payload?.error || 'bot_test_failed')
  }

  return (await response.json()) as { executedJobs: number } & BotStatusPayload
}

export async function resetBotDemo() {
  const response = await fetch(buildApiUrl('/api/bot/reset'), {
    method: 'POST',
    headers: buildAdminHeaders(),
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(payload?.error || 'bot_reset_failed')
  }

  return (await response.json()) as BotStatusPayload
}

export async function connectTeamsSession() {
  const response = await fetch(buildApiUrl('/api/bot/session'), {
    method: 'POST',
    headers: buildAdminHeaders(),
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(payload?.error || 'teams_session_failed')
  }

  return (await response.json()) as { connected: boolean } & BotStatusPayload
}

export async function fetchTopic(topicId: string) {
  const response = await fetch(buildApiUrl(`/api/topics/${encodeURIComponent(topicId)}`))
  if (!response.ok) {
    throw new Error('topic_fetch_failed')
  }

  return (await response.json()) as SubjectTopic
}

export async function fetchTopics() {
  const response = await fetch(buildApiUrl('/api/topics'))
  if (!response.ok) {
    throw new Error('topics_fetch_failed')
  }

  return (await response.json()) as { topics: SubjectTopic[] }
}

export async function generateTopicSummary(topicId: string, force = false) {
  const response = await fetch(buildApiUrl(`/api/topics/${encodeURIComponent(topicId)}/generate-summary`), {
    method: 'POST',
    headers: buildAdminHeaders({
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({ force }),
  })

  if (!response.ok) {
    throw new Error('topic_summary_failed')
  }

  return (await response.json()) as TopicSummaryResult
}

export async function generateTopicMemory(topicId: string, force = false) {
  const response = await fetch(buildApiUrl(`/api/topics/${encodeURIComponent(topicId)}/generate-memory`), {
    method: 'POST',
    headers: buildAdminHeaders({
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({ force }),
  })

  if (!response.ok) {
    throw new Error('topic_memory_failed')
  }

  return (await response.json()) as {
    topicId: string
    memory: TopicAgentMemory
  }
}

export async function generateTopicLearning(topicId: string, force = false) {
  const response = await fetch(buildApiUrl(`/api/topics/${encodeURIComponent(topicId)}/generate-learning`), {
    method: 'POST',
    headers: buildAdminHeaders({
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({ force }),
  })

  if (!response.ok) {
    throw new Error('topic_learning_failed')
  }

  return (await response.json()) as {
    topicId: string
    learning: TopicLearning
  }
}

export async function askTopicAssistant(input: { topicId: string; question: string }) {
  const response = await fetch(buildApiUrl(`/api/topics/${encodeURIComponent(input.topicId)}/ask`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ question: input.question }),
  })

  if (!response.ok) {
    throw new Error('topic_ask_failed')
  }

  return normalizeTopicAskResult((await response.json()) as Partial<TopicAskResult>) as TopicAskResult
}

export async function fetchTopicDebug(topicId: string) {
  const response = await fetch(buildApiUrl(`/api/topics/${encodeURIComponent(topicId)}/debug`), {
    headers: buildAdminHeaders(),
  })

  if (!response.ok) {
    throw new Error('topic_debug_failed')
  }

  return (await response.json()) as TopicDebugResult
}

export function buildBotFileUrl(filePath: string) {
  return buildApiUrl(`/api/files?path=${encodeURIComponent(filePath)}`)
}

export function getStoredAdminToken() {
  return window.sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)?.trim() ?? ''
}

export function storeAdminToken(token: string) {
  const normalized = token.trim()

  if (!normalized) {
    window.sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY)
    return
  }

  window.sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, normalized)
}

export async function fetchHealthStatus() {
  const response = await fetch(buildApiUrl('/api/health'))
  if (!response.ok) {
    throw new Error('health_check_failed')
  }

  return (await response.json()) as {
    ok: true
    adminProtectionEnabled: boolean
  }
}

function normalizeTopicAskResult(payload: Partial<TopicAskResult>) {
  return {
    topicId: payload.topicId ?? '',
    answer: payload.answer ?? 'Nao foi possivel gerar resposta.',
    moduleKey: payload.moduleKey ?? 'geral',
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    usedFallback: payload.usedFallback === true,
    answeredAt: payload.answeredAt ?? new Date().toISOString(),
    confidence: payload.confidence ?? 'medium',
    strategyUsed: payload.strategyUsed ?? (payload.usedFallback ? 'deterministic' : 'memory'),
    providerUsed: payload.providerUsed ?? 'local',
    fallbackLevel: typeof payload.fallbackLevel === 'number' ? payload.fallbackLevel : payload.usedFallback ? 1 : 0,
    citations: Array.isArray(payload.citations) ? payload.citations : [],
    suggestedQuestions: Array.isArray(payload.suggestedQuestions) ? payload.suggestedQuestions : [],
    nextSteps: Array.isArray(payload.nextSteps) ? payload.nextSteps : [],
    qualityStatus: payload.qualityStatus,
    qualityReason: payload.qualityReason,
    answeredByPass: payload.answeredByPass,
    missingSections: Array.isArray(payload.missingSections) ? payload.missingSections : undefined,
  } satisfies TopicAskResult
}

export function syncReadyLessonsIntoWorkspace(
  workspace: WorkspaceState,
  readyLessons: ReadyLesson[],
) {
  if (readyLessons.length === 0) {
    return workspace
  }

  const lessons = [...workspace.lessons]

  readyLessons.forEach((item) => {
    const existingIndex = lessons.findIndex((lesson) => lesson.id === item.lessonId)
    const timestamp = new Date().toISOString()

    if (existingIndex >= 0) {
      const existing = lessons[existingIndex]
      lessons[existingIndex] = mergeImportedLesson(existing, item, timestamp)
      return
    }

    lessons.unshift({
      id: item.lessonId,
      title: normalizeLessonTitle(item.lessonTitle),
      discipline: item.discipline,
      date: item.readyAt.slice(0, 10),
      recordingReference: item.recordingUrl,
      notes: `Importado automaticamente pelo bot do Teams (${item.sourcePlatform}).`,
      status: 'recorded',
      createdAt: timestamp,
      updatedAt: timestamp,
    })
  })

  const transcripts = [...workspace.transcripts]

  readyLessons.forEach((item) => {
    transcripts.unshift({
      id: `${item.jobId}-transcript`,
      lessonId: item.lessonId,
      text: item.transcriptText,
      status: 'completed',
      provider: item.transcriptProvider,
      processedAt: item.transcriptProcessedAt,
    })
  })

  return {
    ...workspace,
    lessons,
    transcripts: dedupeTranscripts(transcripts),
  }
}

function mergeImportedLesson(existing: Lesson, item: ReadyLesson, timestamp: string): Lesson {
  return {
    ...existing,
    title: normalizeLessonTitle(item.lessonTitle),
    discipline: item.discipline,
    recordingReference: item.recordingUrl,
    notes: existing.notes || `Importado automaticamente pelo bot do Teams (${item.sourcePlatform}).`,
    status: existing.status === 'summarized' ? 'summarized' : 'recorded',
    updatedAt: timestamp,
  }
}

function dedupeTranscripts(transcripts: WorkspaceState['transcripts']) {
  const seen = new Set<string>()

  return transcripts.filter((item) => {
    if (seen.has(item.lessonId)) {
      return false
    }

    seen.add(item.lessonId)
    return true
  })
}

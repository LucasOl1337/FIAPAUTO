import type { Lesson, WorkspaceState } from '../types'

const BOT_API_BASE = 'http://127.0.0.1:43872'

export type BotJob = {
  id: string
  lessonId: string
  lessonTitle: string
  discipline: string
  status: string
  platform: 'teams'
  scheduledStart: string
}

export type ReadyLesson = {
  lessonId: string
  jobId: string
  lessonTitle: string
  discipline: string
  meetingUrl: string
  recordingUrl: string
  transcriptText: string
  transcriptProvider: string
  transcriptProcessedAt: string
  readyAt: string
  sourcePlatform: 'teams'
}

export type LiveMeeting = {
  title: string
  joinUrl: string
  channel?: string
  detectedAt: string
}

export type AssignmentItem = {
  id: string
  title: string
  dueText: string
  course: string
  status: 'upcoming' | 'late' | 'completed'
  detailUrl?: string
  downloadedFiles: string[]
  screenshotFiles?: string[]
  localFolder?: string
  error?: string
  capturedAt: string
}

export type LlmStatus = {
  baseUrl: string
  model: string
  enabled: boolean
  hasApiKey: boolean
}

export type LlmDebugEvent = {
  id: string
  ts: string
  endpoint: '/api/upload' | '/api/chat'
  jobId: string
  topicId?: string
  statusCode: number
  durationMs: number
  request: unknown
  response: unknown
  error?: string
}

export type TopicAttachment = {
  path: string
  name: string
}

export type TopicFaqItem = {
  question: string
  answer: string
}

export type TopicAgentMemory = {
  overview: string
  deliverables: string[]
  deadlines: string[]
  faq: TopicFaqItem[]
  keyFacts: string[]
  answerStyle: string
  fallbackPolicy: string
  sourceSnippets: string[]
}

export type SubjectTopic = {
  id: string
  title: string
  course: string
  moduleKey: string
  status: 'upcoming' | 'late' | 'completed'
  dueText: string
  detailUrl?: string
  assignmentIds: string[]
  attachments: TopicAttachment[]
  screenshots: string[]
  contentText: string
  summary: string
  summaryGeneratedAt?: string
  agentMemory: TopicAgentMemory | null
  agentMemoryGeneratedAt?: string
  lastAskedAt?: string
  updatedAt: string
  warnings: string[]
}

export type TopicSummaryResult = {
  topicId: string
  moduleKey: string
  summary: string
  warnings: string[]
  filesUsed: string[]
  generatedAt: string
}

export type TopicAskResult = {
  topicId: string
  answer: string
  moduleKey: string
  warnings: string[]
  usedFallback: boolean
  answeredAt: string
}

export type BotState = {
  jobs: BotJob[]
  readyLessons: ReadyLesson[]
  liveMeetings: LiveMeeting[]
  assignments: AssignmentItem[]
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
  const response = await fetch(`${BOT_API_BASE}/api/bot/status`)
  if (!response.ok) {
    throw new Error('bot_status_failed')
  }

  return (await response.json()) as {
    jobs: BotJob[]
    readyLessons: ReadyLesson[]
    logs: string[]
    workspaceReport: {
      authStatus: BotState['authStatus']
      liveMeetings: LiveMeeting[]
      assignments: AssignmentItem[]
      scannedAt: string
    }
    topics: SubjectTopic[]
    llm: LlmStatus
    llmDebug: BotState['llmDebug']
    runtimeError?: string
  }
}

export async function runBotDemo() {
  const response = await fetch(`${BOT_API_BASE}/api/bot/test`, { method: 'POST' })
  if (!response.ok) {
    if (response.status === 409) {
      const payload = (await response.json()) as {
        error: 'scan_in_progress'
        jobs: BotJob[]
        readyLessons: ReadyLesson[]
        logs: string[]
        workspaceReport: {
          authStatus: BotState['authStatus']
          liveMeetings: LiveMeeting[]
          assignments: AssignmentItem[]
          scannedAt: string
        }
        topics: SubjectTopic[]
        llm: LlmStatus
        llmDebug: BotState['llmDebug']
        runtimeError?: string
      }

      throw Object.assign(new Error('scan_in_progress'), { payload })
    }

    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(payload?.error || 'bot_test_failed')
  }

  return (await response.json()) as {
    executedJobs: number
    jobs: BotJob[]
    readyLessons: ReadyLesson[]
    logs: string[]
    workspaceReport: {
      authStatus: BotState['authStatus']
      liveMeetings: LiveMeeting[]
      assignments: AssignmentItem[]
      scannedAt: string
    }
    topics: SubjectTopic[]
    llm: LlmStatus
    llmDebug: BotState['llmDebug']
    runtimeError?: string
  }
}

export async function resetBotDemo() {
  const response = await fetch(`${BOT_API_BASE}/api/bot/reset`, { method: 'POST' })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(payload?.error || 'bot_reset_failed')
  }

  return (await response.json()) as {
    jobs: BotJob[]
    readyLessons: ReadyLesson[]
    logs: string[]
    workspaceReport: {
      authStatus: BotState['authStatus']
      liveMeetings: LiveMeeting[]
      assignments: AssignmentItem[]
      scannedAt: string
    }
    topics: SubjectTopic[]
    llm: LlmStatus
    llmDebug: BotState['llmDebug']
    runtimeError?: string
  }
}

export async function connectTeamsSession() {
  const response = await fetch(`${BOT_API_BASE}/api/bot/session`, { method: 'POST' })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(payload?.error || 'teams_session_failed')
  }

  return (await response.json()) as {
    connected: boolean
    jobs: BotJob[]
    readyLessons: ReadyLesson[]
    logs: string[]
    workspaceReport: {
      authStatus: BotState['authStatus']
      liveMeetings: LiveMeeting[]
      assignments: AssignmentItem[]
      scannedAt: string
    }
    topics: SubjectTopic[]
    llm: LlmStatus
    llmDebug: BotState['llmDebug']
    runtimeError?: string
  }
}

export async function fetchTopic(topicId: string) {
  const response = await fetch(`${BOT_API_BASE}/api/topics/${encodeURIComponent(topicId)}`)
  if (!response.ok) {
    throw new Error('topic_fetch_failed')
  }

  return (await response.json()) as SubjectTopic
}

export async function generateTopicSummary(topicId: string, force = false) {
  const response = await fetch(`${BOT_API_BASE}/api/topics/${encodeURIComponent(topicId)}/generate-summary`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ force }),
  })

  if (!response.ok) {
    throw new Error('topic_summary_failed')
  }

  return (await response.json()) as TopicSummaryResult
}

export async function generateTopicMemory(topicId: string, force = false) {
  const response = await fetch(`${BOT_API_BASE}/api/topics/${encodeURIComponent(topicId)}/generate-memory`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
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

export async function askTopicAssistant(input: { topicId: string; question: string }) {
  const response = await fetch(`${BOT_API_BASE}/api/topics/${encodeURIComponent(input.topicId)}/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ question: input.question }),
  })

  if (!response.ok) {
    throw new Error('topic_ask_failed')
  }

  return (await response.json()) as TopicAskResult
}

export async function fetchTopicDebug(topicId: string) {
  const response = await fetch(`${BOT_API_BASE}/api/topics/${encodeURIComponent(topicId)}/debug`)

  if (!response.ok) {
    throw new Error('topic_debug_failed')
  }

  return (await response.json()) as {
    topic: SubjectTopic
    events: LlmDebugEvent[]
    llm: LlmStatus
  }
}

export function buildBotFileUrl(filePath: string) {
  return `${BOT_API_BASE}/api/files?path=${encodeURIComponent(filePath)}`
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

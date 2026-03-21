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
  key?: string
  contentType?: string
  size?: number
  publicUrl?: string
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

export type TopicLearningConcept = {
  title: string
  content: string
}

export type TopicLearning = {
  frequentQuestions: TopicFaqItem[]
  simpleConcepts: TopicLearningConcept[]
  quickTips: string[]
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
  learning: TopicLearning | null
  learningGeneratedAt?: string
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
  confidence: 'high' | 'medium' | 'low'
  strategyUsed: 'memory' | 'rag_llm' | 'provider_fallback' | 'deterministic'
  providerUsed?: 'gemini' | 'ollama' | 'local'
  fallbackLevel: number
  citations: Array<{
    sourceType: 'summary' | 'faq' | 'deadline' | 'deliverable' | 'content'
    sourceLabel: string
    snippet: string
  }>
  suggestedQuestions: string[]
  nextSteps: string[]
}

export type BotStatusPayload = {
  jobs: BotJob[]
  readyLessons: ReadyLesson[]
  logs: string[]
  workspaceReport: {
    authStatus: 'authenticated' | 'login_required'
    liveMeetings: LiveMeeting[]
    assignments: AssignmentItem[]
    scannedAt: string
  }
  topics: SubjectTopic[]
  llm: LlmStatus
  llmDebug: {
    historyFile: string
    maxTextChars: number
    events: LlmDebugEvent[]
  }
  runtimeError?: string
}

export type BotState = BotStatusPayload & {
  authStatus: 'authenticated' | 'login_required'
  scannedAt: string
  apiConnected: boolean
}

export type PublishedKnowledgeChunk = {
  id: string
  topicId: string
  moduleKey: string
  sourceType: 'summary' | 'overview' | 'deliverable' | 'deadline' | 'faq' | 'content'
  text: string
  keywords: string[]
  entities: string[]
  capturedAt: string
}

export type PublicManifest = {
  schemaVersion: number
  releaseId: string
  publishedAt: string
  sourceMachine: string
  topicCount: number
  attachmentCount: number
  knowledgeChunkCount: number
  contentHash: string
}

export type PublicTopicListItem = Pick<
  SubjectTopic,
  | 'id'
  | 'title'
  | 'course'
  | 'moduleKey'
  | 'status'
  | 'dueText'
  | 'summary'
  | 'summaryGeneratedAt'
  | 'updatedAt'
> & {
  attachmentCount: number
  screenshotCount: number
}

export type PublicTopic = {
  id: string
  title: string
  course: string
  moduleKey: string
  status: 'upcoming' | 'late' | 'completed'
  dueText: string
  summary: string
  summaryGeneratedAt?: string
  agentMemory: TopicAgentMemory | null
  learning: TopicLearning | null
  attachments: TopicAttachment[]
  screenshots: string[]
  updatedAt: string
}

export type PublicChatResponse = {
  topicId: string
  answer: string
  confidence: 'high' | 'medium' | 'low'
  strategyUsed: 'memory' | 'deterministic'
  providerUsed: 'local'
  citations: Array<{
    sourceType: 'summary' | 'faq' | 'deadline' | 'deliverable' | 'content'
    sourceLabel: string
    snippet: string
  }>
  suggestedQuestions: string[]
  nextSteps: string[]
  answeredAt: string
}

export type PublicSyncStatus = {
  localReleaseId?: string
  localPublishedAt?: string
  remoteReleaseId?: string
  remotePublishedAt?: string
  inSync: boolean
  bucket?: string
  region?: string
}

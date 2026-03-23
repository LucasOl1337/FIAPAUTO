import fs from 'node:fs/promises'
import type {
  PublicChatResponse,
  PublicChatTraceEvent,
  PublicChatTraceSummary,
  PublicModelWarning,
  PublicMonitorStatus,
  PublicTrafficSnapshot,
} from '@fiapauto/contracts'
import { runtimePaths } from '../config/runtimePaths.ts'
import { ensureDir, readJsonFile, writeJsonFile } from '../database/fs.ts'

const EXPECTED_PUBLIC_MODEL = 'qwen3.5:397b-cloud'
const WINDOW_SECONDS = 60
const MAX_EVENTS = 400
const MAX_RECENT_CHATS = 12
const PREVIEW_LIMIT = 220

export async function appendPublicChatTraceEvent(event: PublicChatTraceEvent) {
  await ensureDir(runtimePaths.logsDir)
  await fs.appendFile(runtimePaths.publicChatEventsFile, `${JSON.stringify(event)}\n`, 'utf-8')
  await refreshPublicTrafficSnapshot()
}

export async function readPublicChatTraceHistory(limit = 30) {
  try {
    const raw = await fs.readFile(runtimePaths.publicChatEventsFile, 'utf-8')
    const safeLimit = Math.min(Math.max(limit, 1), MAX_EVENTS)
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-safeLimit)
      .map((line) => {
        try {
          return JSON.parse(line) as PublicChatTraceEvent
        } catch {
          return null
        }
      })
      .filter((item): item is PublicChatTraceEvent => Boolean(item))
      .reverse()
  } catch {
    return []
  }
}

export async function readPublicTrafficSnapshot() {
  return readJsonFile<PublicTrafficSnapshot>(runtimePaths.publicTrafficSnapshotFile, buildEmptySnapshot())
}

export async function getPublicMonitorStatus() {
  const snapshot = await readPublicTrafficSnapshot()
  const latest =
    snapshot.latestStarted
    ?? snapshot.latestCompleted
    ?? snapshot.latestFallback
    ?? snapshot.latestFailure

  return {
    expectedModel: EXPECTED_PUBLIC_MODEL,
    latestProviderUsed: latest?.providerUsed,
    latestModel: latest?.model,
    latestRequestId: latest?.requestId,
    latestRequestAt: latest?.ts,
    modelWarning: snapshot.latestModelWarning,
    traffic: snapshot,
  } satisfies PublicMonitorStatus
}

export async function refreshPublicTrafficSnapshot() {
  const events = await readPublicChatTraceHistory(MAX_EVENTS)
  const now = Date.now()
  const windowStart = now - WINDOW_SECONDS * 1000

  const recentEvents = events.filter((event) => parseEventTime(event.ts) >= windowStart)
  const recentRequestMap = new Map<string, PublicChatTraceEvent>()
  for (const event of recentEvents) {
    const current = recentRequestMap.get(event.requestId)
    if (!current || parseEventTime(event.ts) > parseEventTime(current.ts)) {
      recentRequestMap.set(event.requestId, event)
    }
  }

  const activeIpsMap = new Map<string, { requestCount: number; lastSeenAt: string }>()
  for (const event of recentRequestMap.values()) {
    const clientIp = normalizeIp(event.clientIp)
    const current = activeIpsMap.get(clientIp)
    if (!current) {
      activeIpsMap.set(clientIp, {
        requestCount: 1,
        lastSeenAt: event.ts,
      })
      continue
    }
    current.requestCount += 1
    if (parseEventTime(event.ts) > parseEventTime(current.lastSeenAt)) {
      current.lastSeenAt = event.ts
    }
  }

  const activeIps = [...activeIpsMap.entries()]
    .map(([clientIp, entry]) => ({
      clientIp,
      requestCount: entry.requestCount,
      lastSeenAt: entry.lastSeenAt,
    }))
    .sort((left, right) => {
      if (right.requestCount !== left.requestCount) {
        return right.requestCount - left.requestCount
      }
      return parseEventTime(right.lastSeenAt) - parseEventTime(left.lastSeenAt)
    })

  const recentChats = events.slice(0, MAX_RECENT_CHATS).map(summarizeEvent)
  const latestStarted = events.find((event) => event.phase === 'started')
  const latestCompleted = events.find((event) => !event.error && event.phase !== 'started')
  const latestFailure = events.find((event) => Boolean(event.error) || event.phase === 'failed')
  const latestFallback = events.find((event) => event.qualityStatus === 'fallback')
  const latestModelWarning = events.find((event) => hasModelWarning(event))

  const snapshot = {
    expectedModel: EXPECTED_PUBLIC_MODEL,
    updatedAt: new Date().toISOString(),
    windowSeconds: WINDOW_SECONDS,
    totalRecentRequests: recentRequestMap.size,
    totalActiveIps: activeIps.length,
    activeIps,
    latestStarted: latestStarted ? summarizeEvent(latestStarted) : undefined,
    latestCompleted: latestCompleted ? summarizeEvent(latestCompleted) : undefined,
    latestFailure: latestFailure ? summarizeEvent(latestFailure) : undefined,
    latestFallback: latestFallback ? summarizeEvent(latestFallback) : undefined,
    latestModelWarning: latestModelWarning ? buildModelWarning(latestModelWarning) : undefined,
    recentChats,
  } satisfies PublicTrafficSnapshot

  await writeJsonFile(runtimePaths.publicTrafficSnapshotFile, snapshot)
  return snapshot
}

function buildEmptySnapshot(): PublicTrafficSnapshot {
  return {
    expectedModel: EXPECTED_PUBLIC_MODEL,
    updatedAt: '',
    windowSeconds: WINDOW_SECONDS,
    totalRecentRequests: 0,
    totalActiveIps: 0,
    activeIps: [],
    recentChats: [],
  }
}

function summarizeEvent(event: PublicChatTraceEvent): PublicChatTraceSummary {
  return {
    requestId: event.requestId,
    ts: event.ts,
    phase: event.phase,
    topicId: event.topicId,
    clientIp: normalizeIp(event.clientIp),
    userAgent: truncateText(event.userAgent),
    questionPreview: truncateText(event.question) || '',
    llmPromptPreview: truncateText(event.llmPrompt),
    llmOutputPreview: truncateText(event.llmOutput),
    providerUsed: event.providerUsed,
    strategyUsed: event.strategyUsed,
    qualityStatus: event.qualityStatus,
    answeredByPass: event.answeredByPass,
    model: event.model,
    durationMs: event.durationMs,
    error: truncateText(event.error),
  }
}

function buildModelWarning(event: PublicChatTraceEvent): PublicModelWarning {
  return {
    expectedModel: EXPECTED_PUBLIC_MODEL,
    actualModel: event.model,
    providerUsed: event.providerUsed,
    requestId: event.requestId,
    ts: event.ts,
    source: 'public-chat-trace',
  }
}

function hasModelWarning(event: PublicChatTraceEvent) {
  if (!event.model) {
    return false
  }

  if (event.providerUsed === 'local' && event.model.startsWith('local-')) {
    return false
  }

  return event.model.trim() !== EXPECTED_PUBLIC_MODEL
}

function parseEventTime(value: string) {
  if (!value) {
    return 0
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function truncateText(value: string | undefined) {
  if (!value) {
    return value
  }

  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= PREVIEW_LIMIT) {
    return normalized
  }

  return `${normalized.slice(0, PREVIEW_LIMIT - 3)}...`
}

function normalizeIp(value: string | undefined) {
  const normalized = value?.trim()
  return normalized || 'unknown'
}

export function expectedPublicModel() {
  return EXPECTED_PUBLIC_MODEL
}

export function buildPublicTraceEvent(input: {
  requestId: string
  phase?: 'started' | 'completed' | 'failed'
  clientIp?: string
  userAgent?: string
  topicId: string
  question: string
  llmPrompt?: string
  llmOutput?: string
  finalAnswer?: string
  providerUsed?: PublicChatResponse['providerUsed']
  strategyUsed?: PublicChatResponse['strategyUsed']
  qualityStatus?: PublicChatResponse['qualityStatus']
  answeredByPass?: PublicChatResponse['answeredByPass']
  model?: string
  durationMs?: number
  error?: string
}) {
  return {
    requestId: input.requestId,
    ts: new Date().toISOString(),
    phase: input.phase ?? (input.error ? 'failed' : 'completed'),
    topicId: input.topicId,
    clientIp: input.clientIp,
    userAgent: input.userAgent,
    question: input.question,
    llmPrompt: input.llmPrompt,
    llmOutput: input.llmOutput,
    finalAnswer: input.finalAnswer,
    providerUsed: input.providerUsed,
    strategyUsed: input.strategyUsed,
    qualityStatus: input.qualityStatus,
    answeredByPass: input.answeredByPass,
    model: input.model ?? EXPECTED_PUBLIC_MODEL,
    durationMs: input.durationMs,
    error: input.error,
  } satisfies PublicChatTraceEvent
}

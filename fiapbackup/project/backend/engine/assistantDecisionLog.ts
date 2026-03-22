import fs from 'node:fs/promises'
import { runtimePaths } from '../config/runtimePaths.ts'

const maxEvents = 300

export type AssistantDecisionEvent = {
  id: string
  ts: string
  topicId?: string
  moduleKey?: string
  question: string
  questionType: string
  scopeChosen: 'topic' | 'module' | 'global'
  confidenceScore: number
  usedFallback: boolean
  memoryUpdated: boolean
  responsePreview: string
  sourcesSelected: Array<{
    id: string
    sourceType: string
    score: number
  }>
}

export async function appendAssistantDecisionEvent(event: AssistantDecisionEvent) {
  await fs.mkdir(runtimePaths.logsDir, { recursive: true })
  await fs.appendFile(runtimePaths.decisionHistoryFile, `${JSON.stringify(event)}\n`, 'utf-8')
}

export async function readAssistantDecisionHistory(limit = 50, topicId?: string) {
  try {
    const raw = await fs.readFile(runtimePaths.decisionHistoryFile, 'utf-8')
    const safeLimit = Math.min(Math.max(limit, 1), maxEvents)
    const events = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-safeLimit)
      .map((line) => {
        try {
          return JSON.parse(line) as AssistantDecisionEvent
        } catch {
          return null
        }
      })
      .filter((item): item is AssistantDecisionEvent => Boolean(item))
      .reverse()

    if (!topicId) {
      return events
    }

    return events.filter((event) => event.topicId === topicId)
  } catch {
    return []
  }
}

export function getAssistantDecisionDebugInfo() {
  return {
    historyFile: runtimePaths.decisionHistoryFile,
    maxEvents,
  }
}

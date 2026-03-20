import fs from 'node:fs/promises'
import path from 'node:path'

const outputDir = path.resolve('output')
const historyFile = path.join(outputDir, 'llm-debug-history.jsonl')
const maxTextChars = 12000
const maxEvents = 200

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

export async function appendLlmDebugEvent(event: LlmDebugEvent) {
  await fs.mkdir(outputDir, { recursive: true })
  await fs.appendFile(historyFile, `${JSON.stringify(event)}\n`, 'utf-8')
}

export async function readLlmDebugHistory(limit = 50, topicId?: string) {
  try {
    const raw = await fs.readFile(historyFile, 'utf-8')
    const safeLimit = Math.min(Math.max(limit, 1), maxEvents)
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-safeLimit)

    const events = lines
      .map((line) => {
        try {
          return JSON.parse(line) as LlmDebugEvent
        } catch {
          return null
        }
      })
      .filter((item): item is LlmDebugEvent => Boolean(item))
      .reverse()

    if (!topicId) {
      return events
    }

    return events.filter((event) => event.topicId === topicId)
  } catch {
    return []
  }
}

export function getLlmDebugInfo() {
  return {
    historyFile,
    maxTextChars,
  }
}

export function sanitizeUploadRequest(filePaths: string[]) {
  return filePaths.map((filePath) => path.basename(filePath))
}

export function sanitizeUploadResponse(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return payload
  }

  const source = payload as {
    documents?: unknown
    images?: unknown
    errors?: unknown
  }

  return {
    documents: sanitizeDocuments(source.documents),
    images: sanitizeImages(source.images),
    errors: source.errors,
  }
}

export function sanitizeChatRequest(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return payload
  }

  const source = payload as {
    mode?: unknown
    model?: unknown
    message?: unknown
    documents?: unknown
    images?: unknown
  }

  return {
    mode: source.mode,
    model: source.model,
    message: truncateText(source.message),
    documents: sanitizeDocuments(source.documents),
    images: sanitizeImages(source.images),
  }
}

export function sanitizeChatResponse(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return payload
  }

  const source = payload as {
    content?: unknown
    saved_file?: unknown
  }

  return {
    content: truncateText(source.content),
    saved_file: source.saved_file,
  }
}

function sanitizeDocuments(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  return value.slice(0, 8).map((item) => {
    if (!item || typeof item !== 'object') {
      return item
    }

    const source = item as { name?: unknown; content?: unknown }
    return {
      name: source.name,
      content: truncateText(source.content),
    }
  })
}

function sanitizeImages(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  return value.slice(0, 8).map((item) => {
    if (!item || typeof item !== 'object') {
      return item
    }

    const source = item as { name?: unknown; mime?: unknown; data?: unknown }
    const rawData = typeof source.data === 'string' ? source.data : ''

    return {
      name: source.name,
      mime: source.mime,
      dataLength: rawData.length,
      dataPreview: rawData.slice(0, 80),
    }
  })
}

function truncateText(value: unknown) {
  if (typeof value !== 'string') {
    return value
  }

  if (value.length <= maxTextChars) {
    return value
  }

  return `${value.slice(0, maxTextChars)}...[truncated ${value.length - maxTextChars} chars]`
}

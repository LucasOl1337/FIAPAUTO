import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  appendLlmDebugEvent,
  sanitizeChatRequest,
  sanitizeChatResponse,
  sanitizeUploadRequest,
  sanitizeUploadResponse,
} from './llmDebugStore.ts'

export type LlmDocument = {
  name: string
  content: string
}

export type LlmImage = {
  name?: string
  mime?: string
  data?: string
}

export type LlmUploadResult = {
  documents: LlmDocument[]
  images: LlmImage[]
  errors: string[]
}

type ChatParams = {
  jobId: string
  topicId?: string
  mode: string
  message: string
  documents: LlmDocument[]
  images: LlmImage[]
}

type KeyEntry = {
  name: string
  value: string
}

const localKeysPath = path.resolve('server', 'llmKeys.local.py')
const lojaSyncKeysPath = path.resolve('C:\\Users\\user\\Desktop\\lojasync\\Legacy\\engine\\LLM3\\keys.py')
const lojaSyncLlmDir = path.resolve('C:\\Users\\user\\Desktop\\lojasync\\Legacy\\engine\\LLM3')
const lojaSyncVenvPython = path.resolve('C:\\Users\\user\\Desktop\\lojasync\\.venv\\Scripts\\python.exe')
const localAdapterBaseUrl = 'http://127.0.0.1:8002'

let cachedKeys: KeyEntry[] | null = null
let nextKeyIndex = 0
let adapterStartPromise: Promise<void> | null = null

export function llmBaseUrl() {
  const explicitBaseUrl = process.env.LLM_BASE_URL ?? process.env.OLLAMA_BASE_URL
  if (explicitBaseUrl) {
    return explicitBaseUrl
  }

  if (hasLocalLlmAdapterSource()) {
    return localAdapterBaseUrl
  }

  if (process.env.LLM_API_KEY || process.env.OLLAMA_API_KEY || cachedKeysAvailable()) {
    return 'https://ollama.com'
  }

  const host = process.env.LLM_HOST ?? '127.0.0.1'
  const port = process.env.LLM_PORT ?? '11434'
  return `http://${host}:${port}`
}

export function llmTimeoutMs() {
  const value = Number(process.env.LLM_HTTP_TIMEOUT_MS ?? '120000')
  return Number.isFinite(value) && value > 0 ? value : 120000
}

export function llmConfig() {
  return {
    baseUrl: llmBaseUrl(),
    model: process.env.LLM_MODEL ?? process.env.LLM_MODEL_NAME ?? 'qwen3.5:cloud',
    enabled: Boolean(
      process.env.LLM_BASE_URL ||
        process.env.OLLAMA_BASE_URL ||
        process.env.LLM_HOST ||
        process.env.LLM_API_KEY ||
        process.env.OLLAMA_API_KEY ||
        cachedKeysAvailable(),
    ),
    hasApiKey: Boolean(process.env.LLM_API_KEY || process.env.OLLAMA_API_KEY || cachedKeysAvailable()),
  }
}

function buildHeaders(jobId: string) {
  const headers = new Headers({
    'X-Job-Id': jobId,
  })

  const apiKey = resolveApiKey()
  if (apiKey) {
    const keyHeader = process.env.OLLAMA_API_KEY_HEADER ?? 'Authorization'
    const keyScheme = process.env.OLLAMA_API_KEY_SCHEME ?? 'Bearer'
    headers.set(keyHeader, keyScheme ? `${keyScheme} ${apiKey}` : apiKey)
  }

  return headers
}

export async function uploadFilesToLlm(jobId: string, filePaths: string[], topicId?: string) {
  await ensureLlmBridgeReady()
  const documents: LlmDocument[] = []
  const images: LlmImage[] = []
  const errors: string[] = []

  for (const filePath of filePaths) {
    const startedAt = Date.now()
    const fileName = filePath.split(/[\\/]/).pop() || 'attachment'

    try {
      const bytes = await fs.readFile(filePath)
      const form = new FormData()
      form.append('files', new Blob([bytes]), fileName)

      const response = await fetch(`${llmBaseUrl()}/api/upload`, {
        method: 'POST',
        headers: buildHeaders(jobId),
        body: form,
        signal: AbortSignal.timeout(llmTimeoutMs()),
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        const errorMessage = `upload_failed:${fileName}:${response.status}`
        errors.push(errorMessage)
        await appendLlmDebugEvent({
          id: crypto.randomUUID(),
          ts: new Date().toISOString(),
          endpoint: '/api/upload',
          jobId,
          topicId,
          statusCode: response.status,
          durationMs: Date.now() - startedAt,
          request: sanitizeUploadRequest([filePath]),
          response: errorText,
          error: errorMessage,
        })
        continue
      }

      const data = (await response.json()) as {
        documents?: unknown[]
        images?: unknown[]
        errors?: unknown[]
      }

      for (const item of data.documents ?? []) {
        if (isDocument(item)) {
          documents.push(item)
        }
      }

      for (const item of data.images ?? []) {
        if (isImage(item)) {
          images.push(item)
        }
      }

      for (const item of data.errors ?? []) {
        if (typeof item === 'string' && item.trim()) {
          errors.push(item)
        }
      }

      await appendLlmDebugEvent({
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        endpoint: '/api/upload',
        jobId,
        topicId,
        statusCode: response.status,
        durationMs: Date.now() - startedAt,
        request: sanitizeUploadRequest([filePath]),
        response: sanitizeUploadResponse(data),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'upload_failed'
      errors.push(message)
      await appendLlmDebugEvent({
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        endpoint: '/api/upload',
        jobId,
        topicId,
        statusCode: 500,
        durationMs: Date.now() - startedAt,
        request: sanitizeUploadRequest([filePath]),
        response: '',
        error: message,
      })
    }
  }

  return {
    documents: dedupeDocuments(documents),
    images,
    errors,
  } satisfies LlmUploadResult
}

export async function postLlmChat(params: ChatParams) {
  await ensureLlmBridgeReady()
  const payload = {
    message: params.message,
    mode: params.mode,
    model: process.env.LLM_MODEL || process.env.LLM_MODEL_NAME || undefined,
    documents: params.documents,
    images: params.images,
  }
  const startedAt = Date.now()

  const response = await fetch(`${llmBaseUrl()}/api/chat`, {
    method: 'POST',
    headers: (() => {
      const headers = buildHeaders(params.jobId)
      headers.set('Content-Type', 'application/json')
      return headers
    })(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(llmTimeoutMs()),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    await appendLlmDebugEvent({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      endpoint: '/api/chat',
      jobId: params.jobId,
      topicId: params.topicId,
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
      request: sanitizeChatRequest(payload),
      response: errorText,
      error: `llm_chat_failed:${response.status}`,
    })
    throw new Error(`llm_chat_failed:${response.status}`)
  }

  const data = (await response.json().catch(async () => ({ content: await response.text() }))) as {
    content?: unknown
    saved_file?: unknown
  }

  await appendLlmDebugEvent({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    endpoint: '/api/chat',
    jobId: params.jobId,
    topicId: params.topicId,
    statusCode: response.status,
    durationMs: Date.now() - startedAt,
    request: sanitizeChatRequest(payload),
    response: sanitizeChatResponse(data),
  })

  return {
    content: extractChatContent(data.content).trim(),
    savedFile: typeof data.saved_file === 'string' ? data.saved_file : undefined,
  }
}

function extractChatContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') {
          return item
        }

        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
          return item.text
        }

        return ''
      })
      .join('\n')
  }

  if (content && typeof content === 'object') {
    if ('message' in content && content.message && typeof content.message === 'object') {
      const message = content.message as { content?: unknown }
      return extractChatContent(message.content)
    }

    if ('content' in content) {
      return extractChatContent((content as { content?: unknown }).content)
    }
  }

  return ''
}

function isDocument(value: unknown): value is LlmDocument {
  if (!value || typeof value !== 'object') {
    return false
  }

  const item = value as { name?: unknown; content?: unknown }
  return typeof item.name === 'string' && typeof item.content === 'string'
}

function isImage(value: unknown): value is LlmImage {
  if (!value || typeof value !== 'object') {
    return false
  }

  return true
}

function dedupeDocuments(items: LlmDocument[]) {
  const seen = new Set<string>()

  return items.filter((item) => {
    const key = `${item.name}::${item.content}`
    if (seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}

function resolveApiKey() {
  if (llmBaseUrl() === localAdapterBaseUrl) {
    return undefined
  }

  const directKey = process.env.LLM_API_KEY ?? process.env.OLLAMA_API_KEY
  if (directKey?.trim()) {
    return directKey.trim()
  }

  const keys = readLojaSyncKeys()
  if (keys.length === 0) {
    return undefined
  }

  const selected = keys[nextKeyIndex % keys.length]
  nextKeyIndex = (nextKeyIndex + 1) % keys.length
  return selected.value
}

function cachedKeysAvailable() {
  return readLojaSyncKeys().length > 0
}

function readLojaSyncKeys() {
  if (cachedKeys) {
    return cachedKeys
  }

  try {
    const content = readKeysFile()
    const matches = Array.from(
      content.matchAll(/\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*\)/g),
    )

    cachedKeys = matches.map((match) => ({
      name: match[1],
      value: match[2],
    }))
  } catch {
    cachedKeys = []
  }

  return cachedKeys
}

function readKeysFile() {
  try {
    return readFileSync(localKeysPath, 'utf-8')
  } catch {
    return readFileSync(lojaSyncKeysPath, 'utf-8')
  }
}

function hasLocalLlmAdapterSource() {
  try {
    readFileSync(path.join(lojaSyncLlmDir, 'launcher.py'), 'utf-8')
    return true
  } catch {
    return false
  }
}

async function ensureLlmBridgeReady() {
  if (llmBaseUrl() !== localAdapterBaseUrl) {
    return
  }

  if (await isLlmBridgeUp()) {
    return
  }

  if (!adapterStartPromise) {
    adapterStartPromise = startLocalLlmBridge()
  }

  try {
    await adapterStartPromise
  } finally {
    adapterStartPromise = null
  }
}

async function isLlmBridgeUp() {
  try {
    const response = await fetch(`${localAdapterBaseUrl}/api/status`, {
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch {
    return false
  }
}

async function startLocalLlmBridge() {
  const command = detectPythonCommand()
  const child = spawn(
    command.file,
    [...command.args, '-m', 'uvicorn', 'LLM3.launcher:app', '--host', '127.0.0.1', '--port', '8002'],
    {
    cwd: path.dirname(lojaSyncLlmDir),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    },
  )

  child.unref()

  const startedAt = Date.now()
  while (Date.now() - startedAt < 20000) {
    if (await isLlmBridgeUp()) {
      return
    }

    await wait(1000)
  }

  throw new Error('llm_bridge_unavailable')
}

function detectPythonCommand() {
  try {
    readFileSync(lojaSyncVenvPython)
    return { file: lojaSyncVenvPython, args: [] }
  } catch {
    return { file: 'py', args: ['-3.11'] }
  }
}

function wait(timeMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, timeMs)
  })
}

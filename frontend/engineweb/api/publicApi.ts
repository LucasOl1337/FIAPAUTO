import type {
  PublicChatResponse,
  PublicManifest,
  PublicTopic,
  PublicTopicListItem,
  PublicSyncStatus,
} from '@fiapauto/contracts'
import { resolvePublicApiBase } from '../publicApiBase.ts'

const PUBLIC_API_BASE = resolvePublicApiBase()
const STATIC_PUBLIC_BASE = '/published'
const PUBLIC_API_TIMEOUT_MS = Number(import.meta.env.VITE_PUBLIC_API_TIMEOUT_MS ?? '8000') || 8000
const PUBLIC_CHAT_TIMEOUT_MS = Number(import.meta.env.VITE_PUBLIC_CHAT_TIMEOUT_MS ?? '90000') || 90000

export type PublicTopicChatResult = {
  topicId: string
  answer: string
  sections: PublicChatResponse['sections']
  confidence: 'high' | 'medium' | 'low'
  strategyUsed: PublicChatResponse['strategyUsed']
  providerUsed: PublicChatResponse['providerUsed']
  citations: PublicChatResponse['citations']
  suggestedQuestions: string[]
  nextSteps: string[]
  answeredAt: string
  fallbackLevel?: number
  qualityStatus: 'accepted' | 'regenerated' | 'fallback'
  qualityReason: string
  answeredByPass: 'primary' | 'retry' | 'local' | 'cache'
  missingSections?: string[]
}

function buildPublicApiUrl(path: string) {
  return PUBLIC_API_BASE ? `${PUBLIC_API_BASE}${path}` : path
}

function buildPublicApiCandidateUrls(path: string) {
  if (!PUBLIC_API_BASE) {
    return [buildPublicApiUrl(path)]
  }

  const candidates = [buildPublicApiUrl(path)]
  if (path.startsWith('/api/public/')) {
    candidates.push(buildPublicApiUrl(path.replace('/api/public', '')))
  }

  return [...new Set(candidates)]
}

function buildStaticPublicUrl(path: string) {
  return `${STATIC_PUBLIC_BASE}${path}`
}

async function buildPublicHeaders(init?: HeadersInit) {
  const headers = new Headers(init)
  headers.set('Content-Type', 'application/json')
  if (PUBLIC_API_BASE && /\.loca\.lt$/i.test(new URL(PUBLIC_API_BASE).hostname)) {
    headers.set('bypass-tunnel-reminder', 'true')
  }

  return headers
}

export async function fetchPublicManifest() {
  return fetchWithStaticFallback<PublicManifest>({
    apiPath: '/api/public/manifest',
    staticPath: '/manifest.json',
    errorCode: 'public_manifest_failed',
  })
}

export async function fetchPublicTopics() {
  if (PUBLIC_API_BASE) {
    try {
      const response = await fetchPublicApiWithRetry('/api/public/topics', {
        headers: await buildPublicHeaders(),
      })
      if (response.ok) {
        const payload = (await response.json()) as { topics?: PublicTopicListItem[] }
        if (Array.isArray(payload.topics) && payload.topics.length > 0) {
          return { topics: payload.topics }
        }
      }
    } catch {
      // Fall back to static files when the public API is unavailable or empty.
    }
  }

  const topics = await fetchStaticJson<PublicTopicListItem[]>('/topics.json', 'public_topics_failed')
  return { topics }
}

export async function fetchPublicTopic(topicId: string) {
  return fetchWithStaticFallback<PublicTopic>({
    apiPath: `/api/public/topics/${encodeURIComponent(topicId)}`,
    staticPath: `/topics/${encodeURIComponent(topicId)}.json`,
    errorCode: 'public_topic_failed',
  })
}

export async function askPublicTopic(input: { topicId: string; question: string }) {
  if (!PUBLIC_API_BASE) {
    throw new Error('public_chat_api_base_missing')
  }

  const response = await fetchPublicApiWithRetry('/api/public/chat/topic', {
    method: 'POST',
    headers: await buildPublicHeaders(),
    body: JSON.stringify(input),
  }, {
    attempts: 1,
    timeoutMs: PUBLIC_CHAT_TIMEOUT_MS,
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(payload?.error || 'public_chat_failed')
  }

  return (await response.json()) as PublicTopicChatResult
}

export async function fetchPublicSyncStatus() {
  try {
    return await fetchWithStaticFallback<PublicSyncStatus, PublicManifest>({
      apiPath: '/api/public/sync/status',
      staticPath: '/manifest.json',
      errorCode: 'public_sync_status_failed',
      transformStatic: (manifest) => ({
        localReleaseId: undefined,
        localPublishedAt: undefined,
        remoteReleaseId: manifest.releaseId,
        remotePublishedAt: manifest.publishedAt,
        inSync: false,
      }),
    })
  } catch {
    throw new Error('public_sync_status_failed')
  }
}

export function buildPublicAssetUrl(keyOrUrl: string) {
  if (/^https?:\/\//i.test(keyOrUrl)) {
    return keyOrUrl
  }

  if (!PUBLIC_API_BASE || /^assets\//i.test(keyOrUrl.replace(/^\/+/, ''))) {
    return buildStaticPublicUrl(`/${keyOrUrl.replace(/^\/+/, '')}`)
  }

  return buildPublicApiUrl(`/api/public/assets?key=${encodeURIComponent(keyOrUrl)}`)
}

async function fetchWithStaticFallback<T, TStatic = T>(input: {
  apiPath: string
  staticPath: string
  errorCode: string
  transformStatic?: (value: TStatic) => T
}) {
  if (PUBLIC_API_BASE) {
    try {
      const response = await fetchPublicApiWithRetry(input.apiPath, {
        headers: await buildPublicHeaders(),
      })
      if (response.ok) {
        return (await response.json()) as T
      }
    } catch {
      // Fall back to static files when the public API is unavailable in the lab.
    }
  }

  const payload = await fetchStaticJson<TStatic>(input.staticPath, input.errorCode)
  return input.transformStatic ? input.transformStatic(payload) : (payload as unknown as T)
}

async function fetchStaticJson<T>(path: string, errorCode: string) {
  const response = await fetch(buildStaticPublicUrl(path), {
    headers: { 'Content-Type': 'application/json' },
  })

  if (!response.ok) {
    throw new Error(errorCode)
  }

  return (await response.json()) as T
}

async function fetchPublicApiWithRetry(
  path: string,
  init: RequestInit,
  options?: {
    attempts?: number
    timeoutMs?: number
  },
) {
  const attempts = Math.max(1, options?.attempts ?? 3)
  const timeoutMs = Math.max(1000, options?.timeoutMs ?? PUBLIC_API_TIMEOUT_MS)
  let lastError: unknown
  const candidateUrls = buildPublicApiCandidateUrls(path)

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const url of candidateUrls) {
      const controller = new AbortController()
      const timeoutId = window.setTimeout(() => controller.abort('public_api_timeout'), timeoutMs)

      try {
        const response = await fetch(url, {
          cache: 'no-store',
          ...init,
          signal: controller.signal,
        })
        if (!isTransientPublicApiStatus(response.status) || attempt === attempts - 1) {
          return response
        }
      } catch (error) {
        lastError = error
        if (error instanceof DOMException && error.name === 'AbortError' && attempt === attempts - 1) {
          throw new Error('public_api_timeout')
        }
        if (attempt === attempts - 1) {
          throw error
        }
      } finally {
        window.clearTimeout(timeoutId)
      }
    }

    await delay(350 * (attempt + 1))
  }

  throw lastError instanceof Error ? lastError : new Error('public_api_request_failed')
}

function isTransientPublicApiStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

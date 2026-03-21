import type {
  PublicChatResponse,
  PublicManifest,
  PublicTopic,
  PublicTopicListItem,
  PublishedKnowledgeChunk,
  PublicSyncStatus,
} from '@fiapauto/backend/contracts'
import { getAccessToken, isCognitoConfigured } from '../auth/cognito.ts'
import { answerPublishedTopicQuestion } from './publicAssistant.ts'

const PUBLIC_API_BASE = (import.meta.env.VITE_PUBLIC_API_BASE_URL ?? import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '')
const STATIC_PUBLIC_BASE = '/published'

function buildPublicApiUrl(path: string) {
  return PUBLIC_API_BASE ? `${PUBLIC_API_BASE}${path}` : path
}

function buildStaticPublicUrl(path: string) {
  return `${STATIC_PUBLIC_BASE}${path}`
}

async function buildPublicHeaders(init?: HeadersInit) {
  const headers = new Headers(init)
  headers.set('Content-Type', 'application/json')

  if (isCognitoConfigured()) {
    const token = await getAccessToken()
    if (token) {
      headers.set('Authorization', `Bearer ${token}`)
    }
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
  return fetchWithStaticFallback<{ topics: PublicTopicListItem[] }>({
    apiPath: '/api/public/topics',
    staticPath: '/topics.json',
    errorCode: 'public_topics_failed',
  })
}

export async function fetchPublicTopic(topicId: string) {
  return fetchWithStaticFallback<PublicTopic>({
    apiPath: `/api/public/topics/${encodeURIComponent(topicId)}`,
    staticPath: `/topics/${encodeURIComponent(topicId)}.json`,
    errorCode: 'public_topic_failed',
  })
}

export async function askPublicTopic(input: { topicId: string; question: string }) {
  if (PUBLIC_API_BASE) {
    try {
      const response = await fetch(buildPublicApiUrl('/api/public/chat/topic'), {
        method: 'POST',
        headers: await buildPublicHeaders(),
        body: JSON.stringify(input),
      })
      if (response.ok) {
        return (await response.json()) as PublicChatResponse
      }
    } catch {
      // Fall back to the static deterministic assistant below.
    }
  }

  const [topic, chunks] = await Promise.all([
    fetchPublicTopic(input.topicId),
    fetchStaticJson<PublishedKnowledgeChunk[]>('/knowledge/chunks.json', 'public_chat_failed'),
  ])

  return answerPublishedTopicQuestion({
    topic,
    chunks,
    question: input.question,
  })
}

export async function fetchPublicSyncStatus() {
  try {
    return await fetchWithStaticFallback<PublicSyncStatus>({
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

  if (!PUBLIC_API_BASE) {
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
      const response = await fetch(buildPublicApiUrl(input.apiPath), {
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

import type {
  PublicChatResponse,
  PublicManifest,
  PublicTopic,
  PublicTopicListItem,
  PublicSyncStatus,
} from '@fiapauto/backend/contracts'
import { getAccessToken, isCognitoConfigured } from '../auth/cognito.ts'

const PUBLIC_API_BASE = (import.meta.env.VITE_PUBLIC_API_BASE_URL ?? import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '')

function buildPublicApiUrl(path: string) {
  return PUBLIC_API_BASE ? `${PUBLIC_API_BASE}${path}` : path
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
  const response = await fetch(buildPublicApiUrl('/api/public/manifest'), {
    headers: await buildPublicHeaders(),
  })
  if (!response.ok) {
    throw new Error('public_manifest_failed')
  }

  return (await response.json()) as PublicManifest
}

export async function fetchPublicTopics() {
  const response = await fetch(buildPublicApiUrl('/api/public/topics'), {
    headers: await buildPublicHeaders(),
  })
  if (!response.ok) {
    throw new Error('public_topics_failed')
  }

  return (await response.json()) as { topics: PublicTopicListItem[] }
}

export async function fetchPublicTopic(topicId: string) {
  const response = await fetch(buildPublicApiUrl(`/api/public/topics/${encodeURIComponent(topicId)}`), {
    headers: await buildPublicHeaders(),
  })
  if (!response.ok) {
    throw new Error('public_topic_failed')
  }

  return (await response.json()) as PublicTopic
}

export async function askPublicTopic(input: { topicId: string; question: string }) {
  const response = await fetch(buildPublicApiUrl('/api/public/chat/topic'), {
    method: 'POST',
    headers: await buildPublicHeaders(),
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error('public_chat_failed')
  }

  return (await response.json()) as PublicChatResponse
}

export async function fetchPublicSyncStatus() {
  const response = await fetch(buildPublicApiUrl('/api/public/sync/status'), {
    headers: await buildPublicHeaders(),
  })
  if (!response.ok) {
    throw new Error('public_sync_status_failed')
  }

  return (await response.json()) as PublicSyncStatus
}

export function buildPublicAssetUrl(keyOrUrl: string) {
  if (/^https?:\/\//i.test(keyOrUrl)) {
    return keyOrUrl
  }

  return buildPublicApiUrl(`/api/public/assets?key=${encodeURIComponent(keyOrUrl)}`)
}

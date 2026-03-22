import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  PublicChatResponse,
  PublicManifest,
  PublicSyncStatus,
  PublicTopic,
  PublicTopicListItem,
  PublishedKnowledgeChunk,
} from '../apis/contracts/index.ts'
import { frontendPaths, runtimePaths } from '../config/runtimePaths.ts'
import { getLocalPublishStatus, readCurrentLocalChunks, readCurrentLocalManifest, readCurrentLocalTopic, readCurrentLocalTopicList } from '../publish/service.ts'
import { answerPublishedTopicQuestion } from './assistant.ts'

const frontendPublishedDir = path.join(frontendPaths.frontendRootDir, 'public', 'published')

export async function getPublishedManifest() {
  const runtimeManifest = await readCurrentLocalManifest()
  if (runtimeManifest) {
    return runtimeManifest
  }

  return readFrontendPublishedJson<PublicManifest | null>('manifest.json', null)
}

export async function listPublishedTopics() {
  const runtimeTopics = await readCurrentLocalTopicList()
  if (runtimeTopics.length > 0) {
    return runtimeTopics
  }

  return readFrontendPublishedJson<PublicTopicListItem[]>('topics.json', [])
}

export async function getPublishedTopic(topicId: string) {
  const topic =
    (await readCurrentLocalTopic(topicId)) ??
    (await readFrontendPublishedJson<PublicTopic | null>(path.join('topics', `${topicId}.json`), null))
  if (!topic) {
    throw new Error('public_topic_not_found')
  }

  return topic
}

export async function askPublishedTopic(input: { topicId: string; question: string }) {
  const topic = await getPublishedTopic(input.topicId)
  const runtimeChunks = await readCurrentLocalChunks()
  const chunks =
    runtimeChunks.length > 0
      ? runtimeChunks
      : await readFrontendPublishedJson<PublishedKnowledgeChunk[]>(path.join('knowledge', 'chunks.json'), [])
  return answerPublishedTopicQuestion({
    topic,
    chunks,
    question: input.question,
  })
}

export async function readPublishedAsset(key: string) {
  const sanitizedKey = key.replace(/^\/+/, '')
  const roots = [runtimePaths.publicCurrentDir, frontendPublishedDir]

  for (const rootDir of roots) {
    const resolved = path.resolve(rootDir, ...sanitizedKey.split('/'))
    const root = path.resolve(rootDir)

    if (!resolved.startsWith(root)) {
      continue
    }

    try {
      const buffer = await fs.readFile(resolved)
      return {
        buffer,
        contentType: guessMimeType(resolved),
      }
    } catch {
      // Try next root.
    }
  }

  throw new Error('public_asset_not_found')
}

export async function getPublishedSyncStatus() {
  return getLocalPublishStatus(null)
}

export type {
  PublicChatResponse,
  PublicManifest,
  PublicSyncStatus,
  PublicTopic,
  PublicTopicListItem,
  PublishedKnowledgeChunk,
}

function guessMimeType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.pdf') return 'application/pdf'
  if (extension === '.json') return 'application/json; charset=utf-8'
  if (extension === '.txt') return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

async function readFrontendPublishedJson<T>(relativePath: string, fallback: T): Promise<T> {
  const filePath = path.join(frontendPublishedDir, relativePath)
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

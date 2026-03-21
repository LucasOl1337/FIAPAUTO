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
import { runtimePaths } from '../config/runtimePaths.ts'
import { getLocalPublishStatus, readCurrentLocalChunks, readCurrentLocalManifest, readCurrentLocalTopic, readCurrentLocalTopicList } from '../publish/service.ts'
import { answerPublishedTopicQuestion } from './assistant.ts'

export async function getPublishedManifest() {
  return readCurrentLocalManifest()
}

export async function listPublishedTopics() {
  return readCurrentLocalTopicList()
}

export async function getPublishedTopic(topicId: string) {
  const topic = await readCurrentLocalTopic(topicId)
  if (!topic) {
    throw new Error('public_topic_not_found')
  }

  return topic
}

export async function askPublishedTopic(input: { topicId: string; question: string }) {
  const topic = await getPublishedTopic(input.topicId)
  const chunks = await readCurrentLocalChunks()
  return answerPublishedTopicQuestion({
    topic,
    chunks,
    question: input.question,
  })
}

export async function readPublishedAsset(key: string) {
  const sanitizedKey = key.replace(/^\/+/, '')
  const resolved = path.resolve(runtimePaths.publicCurrentDir, ...sanitizedKey.split('/'))
  const root = path.resolve(runtimePaths.publicCurrentDir)

  if (!resolved.startsWith(root)) {
    throw new Error('public_asset_not_allowed')
  }

  const buffer = await fs.readFile(resolved)
  return {
    buffer,
    contentType: guessMimeType(resolved),
  }
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

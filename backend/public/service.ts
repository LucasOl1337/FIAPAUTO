import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  PublicChatResponse,
  PublicManifest,
  PublicSyncStatus,
  PublicTopic,
  PublicTopicListItem,
  PublishedKnowledgeChunk,
} from '@fiapauto/contracts'
import { frontendPaths, runtimePaths } from '../config/runtimePaths.ts'
import { getLocalPublishStatus, readCurrentLocalChunks, readCurrentLocalManifest, readCurrentLocalTopic, readCurrentLocalTopicList } from '../publish/service.ts'
import { answerPublishedTopicQuestion, type PublicTraceContext } from './assistant.ts'
import { getPublicMonitorStatus } from './monitorStore.ts'

const frontendPublishedDir = path.join(frontendPaths.frontendRootDir, 'public', 'published')
const configuredPublishedSource = normalizePublishedSource(process.env.FIAPAUTO_PUBLISHED_SOURCE)

export type PublishedStore = {
  readManifest: () => Promise<PublicManifest | null>
  readTopics: () => Promise<PublicTopicListItem[]>
  readTopic: (topicId: string) => Promise<PublicTopic | null>
  readChunks: () => Promise<PublishedKnowledgeChunk[]>
  readAsset: (key: string) => Promise<{ buffer: Buffer; contentType: string }>
}

export function createPublishedStore(source = configuredPublishedSource): PublishedStore {
  return source === 'runtime' ? createRuntimePublishedStore() : createRepoPublishedStore()
}

export async function getPublishedManifest() {
  return createPublishedStore().readManifest()
}

export async function listPublishedTopics() {
  return createPublishedStore().readTopics()
}

export async function getPublishedTopic(topicId: string) {
  const topic = await createPublishedStore().readTopic(topicId)
  if (!topic) {
    throw new Error('public_topic_not_found')
  }

  return topic
}

export async function askPublishedTopic(input: { topicId: string; question: string; traceContext?: PublicTraceContext }) {
  const store = createPublishedStore()
  const topic = await store.readTopic(input.topicId)
  if (!topic) {
    throw new Error('public_topic_not_found')
  }
  const chunks = await store.readChunks()
  return answerPublishedTopicQuestion({
    topic,
    chunks,
    question: input.question,
    traceContext: input.traceContext,
  })
}

export async function readPublishedAsset(key: string) {
  return createPublishedStore().readAsset(key)
}

export async function getPublishedSyncStatus() {
  return getLocalPublishStatus(null)
}

export async function getPublishedMonitorStatus() {
  return getPublicMonitorStatus()
}

export type {
  PublicChatResponse,
  PublicManifest,
  PublicSyncStatus,
  PublicTopic,
  PublicTopicListItem,
  PublishedKnowledgeChunk,
}

function createRepoPublishedStore(): PublishedStore {
  return {
    readManifest: () => readFrontendPublishedJson<PublicManifest | null>('manifest.json', null),
    readTopics: () => readFrontendPublishedJson<PublicTopicListItem[]>('topics.json', []),
    readTopic: (topicId) => readFrontendPublishedJson<PublicTopic | null>(path.join('topics', `${topicId}.json`), null),
    readChunks: () => readFrontendPublishedJson<PublishedKnowledgeChunk[]>(path.join('knowledge', 'chunks.json'), []),
    readAsset: (key) => readPublishedAssetFromRoot(frontendPublishedDir, key),
  }
}

function createRuntimePublishedStore(): PublishedStore {
  return {
    readManifest: () => readCurrentLocalManifest(),
    readTopics: () => readCurrentLocalTopicList(),
    readTopic: (topicId) => readCurrentLocalTopic(topicId),
    readChunks: () => readCurrentLocalChunks(),
    readAsset: (key) => readPublishedAssetFromRoot(runtimePaths.publicCurrentDir, key),
  }
}

function normalizePublishedSource(value: string | undefined) {
  return value?.trim().toLowerCase() === 'runtime' ? 'runtime' : 'repo'
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

async function readPublishedAssetFromRoot(rootDir: string, key: string) {
  const sanitizedKey = key.replace(/^\/+/, '')
  const resolved = path.resolve(rootDir, ...sanitizedKey.split('/'))
  const root = path.resolve(rootDir)

  if (!resolved.startsWith(root)) {
    throw new Error('public_asset_not_found')
  }

  const buffer = await fs.readFile(resolved)
  return {
    buffer,
    contentType: guessMimeType(resolved),
  }
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

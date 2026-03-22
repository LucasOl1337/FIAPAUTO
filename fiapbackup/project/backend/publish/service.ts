import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runtimePaths } from '../config/runtimePaths.ts'
import { ensureDir, readJsonFile, writeJsonFile } from '../database/fs.ts'
import { readKnowledgeChunks, rebuildKnowledgeWarehouse } from '../engine/knowledgeWarehouse.ts'
import { syncTopicsFromAssignments } from '../engine/subjectTopics.ts'
import type {
  PublicManifest,
  PublicSyncStatus,
  PublicTopic,
  PublicTopicListItem,
  PublishedKnowledgeChunk,
  TopicAttachment,
} from '../apis/contracts/index.ts'

type CurrentReleasePointer = {
  releaseId: string
  publishedAt: string
}

export type PreparedPublicBundle = {
  manifest: PublicManifest
  releaseDir: string
  currentDir: string
  topics: PublicTopic[]
  topicList: PublicTopicListItem[]
  chunks: PublishedKnowledgeChunk[]
}

const schemaVersion = 1
let currentBundlePromise: Promise<PublicManifest> | null = null

export async function preparePublicBundle() {
  await ensureDir(runtimePaths.publicReleasesDir)
  await ensureDir(runtimePaths.publicCurrentDir)

  const topics = await syncTopicsFromAssignments()
  let chunks = await readKnowledgeChunks()

  if (chunks.length === 0) {
    await rebuildKnowledgeWarehouse()
    chunks = await readKnowledgeChunks()
  }

  const releaseId = buildReleaseId()
  const releaseDir = path.join(runtimePaths.publicReleasesDir, releaseId)
  const assetsDir = path.join(releaseDir, 'assets')

  await fs.rm(releaseDir, { recursive: true, force: true })
  await ensureDir(releaseDir)
  await ensureDir(assetsDir)

  const publicTopics: PublicTopic[] = []
  let attachmentCount = 0

  for (const topic of topics) {
    const attachments = (await Promise.all(
      topic.attachments.map((attachment) => copyAssetIntoRelease(releaseDir, topic.id, 'attachments', attachment.path, attachment.name)),
    )).flatMap((item) => (item ? [item] : []))
    const screenshots = (await Promise.all(
      topic.screenshots.map((screenshotPath, index) =>
        copyAssetIntoRelease(
          releaseDir,
          topic.id,
          'screenshots',
          screenshotPath,
          path.basename(screenshotPath) || `screenshot-${index + 1}.png`,
        ),
      ),
    )).flatMap((item) => (item ? [item] : []))

    attachmentCount += attachments.length + screenshots.length
    publicTopics.push({
      id: topic.id,
      title: topic.title,
      course: topic.course,
      moduleKey: topic.moduleKey,
      status: topic.status,
      dueText: topic.dueText,
      summary: topic.summary,
      summaryGeneratedAt: topic.summaryGeneratedAt,
      agentMemory: topic.agentMemory,
      learning: topic.learning,
      attachments,
      screenshots: screenshots.map((item) => item.key ?? item.path),
      updatedAt: topic.updatedAt,
    })
  }

  const publicChunks = chunks.map((chunk) => ({
    id: chunk.id,
    topicId: chunk.topicId,
    moduleKey: chunk.moduleKey,
    sourceType: chunk.sourceType,
    text: chunk.text,
    keywords: chunk.keywords,
    entities: chunk.entities,
    capturedAt: chunk.capturedAt,
  })) satisfies PublishedKnowledgeChunk[]

  const topicList = publicTopics.map((topic) => ({
    id: topic.id,
    title: topic.title,
    course: topic.course,
    moduleKey: topic.moduleKey,
    status: topic.status,
    dueText: topic.dueText,
    summary: topic.summary,
    summaryGeneratedAt: topic.summaryGeneratedAt,
    updatedAt: topic.updatedAt,
    attachmentCount: topic.attachments.length,
    screenshotCount: topic.screenshots.length,
  })) satisfies PublicTopicListItem[]

  await writeJsonFile(path.join(releaseDir, 'topics.json'), topicList)
  await ensureDir(path.join(releaseDir, 'topics'))
  for (const topic of publicTopics) {
    await writeJsonFile(path.join(releaseDir, 'topics', `${topic.id}.json`), topic)
  }

  await ensureDir(path.join(releaseDir, 'knowledge'))
  await writeJsonFile(path.join(releaseDir, 'knowledge', 'chunks.json'), publicChunks)

  const publishedAt = new Date().toISOString()
  const contentHash = buildContentHash({
    topics: publicTopics,
    topicList,
    chunks: publicChunks,
  })
  const manifest: PublicManifest = {
    schemaVersion,
    releaseId,
    publishedAt,
    sourceMachine: os.hostname(),
    topicCount: publicTopics.length,
    attachmentCount,
    knowledgeChunkCount: publicChunks.length,
    contentHash,
  }

  await writeJsonFile(path.join(releaseDir, 'manifest.json'), manifest)
  await writeJsonFile(runtimePaths.publicCurrentReleaseFile, {
    releaseId,
    publishedAt,
  } satisfies CurrentReleasePointer)

  await replaceCurrentBundle(releaseDir, releaseId)

  return {
    manifest,
    releaseDir,
    currentDir: runtimePaths.publicCurrentDir,
    topics: publicTopics,
    topicList,
    chunks: publicChunks,
  } satisfies PreparedPublicBundle
}

export async function readCurrentLocalManifest() {
  return readJsonFile<PublicManifest | null>(path.join(runtimePaths.publicCurrentDir, 'manifest.json'), null)
}

export async function ensureCurrentLocalBundle() {
  const manifest = await readCurrentLocalManifest()
  if (manifest) {
    return manifest
  }

  if (!currentBundlePromise) {
    currentBundlePromise = preparePublicBundle()
      .then((result) => result.manifest)
      .finally(() => {
        currentBundlePromise = null
      })
  }

  return currentBundlePromise
}

export async function readCurrentLocalTopicList() {
  await ensureCurrentLocalBundle()
  return readJsonFile<PublicTopicListItem[]>(path.join(runtimePaths.publicCurrentDir, 'topics.json'), [])
}

export async function readCurrentLocalTopic(topicId: string) {
  await ensureCurrentLocalBundle()
  return readJsonFile<PublicTopic | null>(path.join(runtimePaths.publicCurrentDir, 'topics', `${topicId}.json`), null)
}

export async function readCurrentLocalChunks() {
  await ensureCurrentLocalBundle()
  return readJsonFile<PublishedKnowledgeChunk[]>(path.join(runtimePaths.publicCurrentDir, 'knowledge', 'chunks.json'), [])
}

export async function readLocalPublishPointer() {
  return readJsonFile<CurrentReleasePointer | null>(runtimePaths.publicCurrentReleaseFile, null)
}

export async function getLocalPublishStatus(remoteManifest?: PublicManifest | null, bucket?: string, region?: string) {
  const localManifest = await readCurrentLocalManifest()
  return {
    localReleaseId: localManifest?.releaseId,
    localPublishedAt: localManifest?.publishedAt,
    remoteReleaseId: remoteManifest?.releaseId,
    remotePublishedAt: remoteManifest?.publishedAt,
    inSync:
      Boolean(localManifest?.releaseId) &&
      localManifest?.releaseId === remoteManifest?.releaseId &&
      localManifest?.contentHash === remoteManifest?.contentHash,
    bucket,
    region,
  } satisfies PublicSyncStatus
}

async function copyAssetIntoRelease(
  releaseDir: string,
  topicId: string,
  group: 'attachments' | 'screenshots',
  sourcePath: string,
  originalName: string,
): Promise<TopicAttachment | null> {
  try {
    const resolved = path.resolve(sourcePath)
    const extension = path.extname(originalName) || path.extname(resolved)
    const baseName = path.basename(originalName, extension) || path.basename(resolved, extension)
    const uniqueSuffix = crypto.createHash('sha1').update(`${resolved}:${originalName}`).digest('hex').slice(0, 10)
    const safeName = `${slugify(baseName) || group}-${uniqueSuffix}${extension.toLowerCase()}`
    const key = path.posix.join('assets', group, topicId, safeName)
    const targetPath = path.join(releaseDir, ...key.split('/'))

    await ensureDir(path.dirname(targetPath))
    const buffer = await fs.readFile(resolved)
    await fs.writeFile(targetPath, buffer)
    const stats = await fs.stat(targetPath)

    return {
      path: key,
      key,
      name: originalName,
      contentType: guessMimeType(targetPath),
      size: stats.size,
    } satisfies TopicAttachment
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : ''
    if (code === 'EBUSY' || code === 'EPERM') {
      return null
    }

    throw error
  }
}

function buildReleaseId() {
  const now = new Date()
  const compact = now.toISOString().replace(/[-:]/g, '').replace(/\./g, '-')
  const randomSuffix = crypto.randomBytes(3).toString('hex')
  return `release-${compact}-${randomSuffix}`
}

function buildContentHash(input: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
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

async function copyDirectoryContents(sourceDir: string, targetDir: string) {
  await ensureDir(targetDir)
  const entries = await fs.readdir(sourceDir, { withFileTypes: true })

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)

    if (entry.isDirectory()) {
      await copyDirectoryContents(sourcePath, targetPath)
      continue
    }

    await ensureDir(path.dirname(targetPath))
    await fs.copyFile(sourcePath, targetPath)
  }
}

async function replaceCurrentBundle(releaseDir: string, releaseId: string) {
  const stagingDir = path.join(runtimePaths.publicSyncDir, `current-next-${releaseId}`)
  const previousDir = path.join(runtimePaths.publicSyncDir, 'current-previous')

  await fs.rm(stagingDir, { recursive: true, force: true })
  await copyDirectoryContents(releaseDir, stagingDir)

  try {
    await fs.rm(previousDir, { recursive: true, force: true })
  } catch {
    // Best effort cleanup of an old backup directory.
  }

  try {
    await fs.rename(runtimePaths.publicCurrentDir, previousDir)
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : ''
    if (code !== 'ENOENT') {
      throw error
    }
  }

  try {
    await fs.rename(stagingDir, runtimePaths.publicCurrentDir)
  } catch (error) {
    try {
      await fs.rm(runtimePaths.publicCurrentDir, { recursive: true, force: true })
    } catch {
      // Ignore and retry the final rename once.
    }
    await fs.rename(stagingDir, runtimePaths.publicCurrentDir)
  } finally {
    try {
      await fs.rm(previousDir, { recursive: true, force: true })
    } catch {
      // Readers may keep files open on Windows; keep the latest current bundle anyway.
    }
  }
}

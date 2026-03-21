import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type _Object,
} from '@aws-sdk/client-s3'
import type { PublicManifest } from '../apis/contracts/index.ts'
import { runtimePaths } from '../config/runtimePaths.ts'
import { ensureDir } from '../database/fs.ts'
import { getLocalPublishStatus, preparePublicBundle, readCurrentLocalManifest } from './service.ts'

type PublishEnv = {
  bucket: string
  region: string
  prefix: string
}

export async function pushCurrentBundleToS3() {
  const prepared = await preparePublicBundle()
  const env = readPublishEnv()
  const client = new S3Client({ region: env.region })
  const localFiles = await listLocalFiles(prepared.currentDir)

  for (const filePath of localFiles) {
    const relativeKey = toPosixPath(path.relative(prepared.currentDir, filePath))
    const body = await fs.readFile(filePath)

    await client.send(
      new PutObjectCommand({
        Bucket: env.bucket,
        Key: joinS3Key(env.prefix, 'current', relativeKey),
        Body: body,
        ContentType: guessMimeType(filePath),
      }),
    )

    await client.send(
      new PutObjectCommand({
        Bucket: env.bucket,
        Key: joinS3Key(env.prefix, 'releases', prepared.manifest.releaseId, relativeKey),
        Body: body,
        ContentType: guessMimeType(filePath),
      }),
    )
  }

  return {
    manifest: prepared.manifest,
    bucket: env.bucket,
    region: env.region,
    prefix: env.prefix,
    uploadedFiles: localFiles.length,
  }
}

export async function pullCurrentBundleFromS3() {
  const env = readPublishEnv()
  const client = new S3Client({ region: env.region })
  const objects = await listAllObjects(client, env.bucket, joinS3Key(env.prefix, 'current'))

  await fs.rm(runtimePaths.publicPullDir, { recursive: true, force: true })
  await ensureDir(runtimePaths.publicPullDir)

  for (const item of objects) {
    if (!item.Key || item.Key.endsWith('/')) {
      continue
    }

    const relative = stripPrefix(item.Key, joinS3Key(env.prefix, 'current'))
    const targetPath = path.join(runtimePaths.publicPullDir, ...relative.split('/'))
    await ensureDir(path.dirname(targetPath))

    const response = await client.send(
      new GetObjectCommand({
        Bucket: env.bucket,
        Key: item.Key,
      }),
    )

    const buffer = await streamToBuffer(response.Body)
    await fs.writeFile(targetPath, buffer)
  }

  return {
    bucket: env.bucket,
    region: env.region,
    prefix: env.prefix,
    outputDir: runtimePaths.publicPullDir,
    fileCount: objects.filter((item) => item.Key && !item.Key.endsWith('/')).length,
  }
}

export async function readRemoteCurrentManifest() {
  const env = readPublishEnv()
  const client = new S3Client({ region: env.region })

  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: env.bucket,
        Key: joinS3Key(env.prefix, 'current', 'manifest.json'),
      }),
    )

    const buffer = await streamToBuffer(response.Body)
    return JSON.parse(buffer.toString('utf-8')) as PublicManifest
  } catch {
    return null
  }
}

export async function readPublishStatus() {
  const env = readPublishEnv()
  const remoteManifest = await readRemoteCurrentManifest()
  return getLocalPublishStatus(remoteManifest, env.bucket, env.region)
}

export async function readLocalOnlyStatus() {
  const localManifest = await readCurrentLocalManifest()
  return {
    localReleaseId: localManifest?.releaseId,
    localPublishedAt: localManifest?.publishedAt,
    remoteReleaseId: undefined,
    remotePublishedAt: undefined,
    inSync: false,
  }
}

export function readPublishEnv() {
  const bucket = process.env.FIAPAUTO_PUBLIC_BUCKET?.trim() ?? ''
  const region = process.env.FIAPAUTO_AWS_REGION?.trim() ?? process.env.AWS_REGION?.trim() ?? ''
  const prefix = (process.env.FIAPAUTO_PUBLIC_PREFIX?.trim() ?? '').replace(/^\/+|\/+$/g, '')

  if (!bucket) {
    throw new Error('FIAPAUTO_PUBLIC_BUCKET_not_configured')
  }

  if (!region) {
    throw new Error('FIAPAUTO_AWS_REGION_not_configured')
  }

  return {
    bucket,
    region,
    prefix,
  } satisfies PublishEnv
}

async function listLocalFiles(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true })
  const results: string[] = []

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      results.push(...(await listLocalFiles(fullPath)))
      continue
    }

    results.push(fullPath)
  }

  return results
}

async function listAllObjects(client: S3Client, bucket: string, prefix: string) {
  const results: _Object[] = []
  let continuationToken: string | undefined

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    )
    results.push(...(response.Contents ?? []))
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
  } while (continuationToken)

  return results
}

function joinS3Key(...parts: string[]) {
  return parts
    .filter(Boolean)
    .map((item) => item.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

function stripPrefix(value: string, prefix: string) {
  const normalizedPrefix = prefix.replace(/\/+$/g, '')
  return value.startsWith(`${normalizedPrefix}/`) ? value.slice(normalizedPrefix.length + 1) : value
}

function toPosixPath(value: string) {
  return value.split(path.sep).join('/')
}

async function streamToBuffer(body: unknown) {
  if (body instanceof Readable) {
    const chunks: Buffer[] = []
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  if (body && typeof body === 'object' && 'transformToByteArray' in body && typeof body.transformToByteArray === 'function') {
    const bytes = await body.transformToByteArray()
    return Buffer.from(bytes)
  }

  return Buffer.alloc(0)
}

function guessMimeType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.json') return 'application/json; charset=utf-8'
  if (extension === '.txt') return 'text/plain; charset=utf-8'
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.pdf') return 'application/pdf'
  return 'application/octet-stream'
}

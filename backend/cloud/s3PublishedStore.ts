import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type {
  PublicManifest,
  PublicTopic,
  PublicTopicListItem,
  PublishedKnowledgeChunk,
} from '@fiapauto/contracts'

const bucket = process.env.FIAPAUTO_PUBLIC_BUCKET?.trim() ?? ''
const region = process.env.FIAPAUTO_AWS_REGION?.trim() ?? process.env.AWS_REGION?.trim() ?? ''
const prefix = (process.env.FIAPAUTO_PUBLIC_PREFIX?.trim() ?? '').replace(/^\/+|\/+$/g, '')

export function createPublishedS3Store() {
  if (!bucket || !region) {
    throw new Error('cloud_public_store_not_configured')
  }

  const client = new S3Client({ region })

  return {
    async readManifest() {
      return readJson<PublicManifest>(client, 'manifest.json')
    },
    async readTopics() {
      return readJson<{ topics: PublicTopicListItem[] }>(client, 'topics.json')
    },
    async readTopic(topicId: string) {
      return readJson<PublicTopic>(client, `topics/${topicId}.json`)
    },
    async readChunks() {
      return readJson<PublishedKnowledgeChunk[]>(client, 'knowledge/chunks.json')
    },
    async readAsset(key: string) {
      const response = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: joinKey('current', key.replace(/^\/+/, '')),
        }),
      )

      const buffer = await streamToBuffer(response.Body)
      return {
        buffer,
        contentType: response.ContentType || 'application/octet-stream',
      }
    },
    config: {
      bucket,
      region,
      prefix,
    },
  }
}

async function readJson<T>(client: S3Client, relativeKey: string) {
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: joinKey('current', relativeKey),
    }),
  )

  const buffer = await streamToBuffer(response.Body)
  return JSON.parse(buffer.toString('utf-8')) as T
}

function joinKey(...parts: string[]) {
  return [prefix, ...parts]
    .filter(Boolean)
    .map((item) => item.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

async function streamToBuffer(body: unknown) {
  if (body && typeof body === 'object' && 'transformToByteArray' in body && typeof body.transformToByteArray === 'function') {
    const bytes = await body.transformToByteArray()
    return Buffer.from(bytes)
  }

  return Buffer.alloc(0)
}

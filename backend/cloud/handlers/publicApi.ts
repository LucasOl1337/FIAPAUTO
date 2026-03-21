import { answerPublishedTopicQuestion } from '../../public/assistant.ts'
import { createPublishedS3Store } from '../s3PublishedStore.ts'

type HttpEvent = {
  rawPath: string
  rawQueryString?: string
  requestContext?: {
    http?: {
      method?: string
    }
    authorizer?: {
      jwt?: {
        claims?: Record<string, string>
      }
    }
  }
  body?: string | null
}

export async function handler(event: HttpEvent) {
  if (!event.requestContext?.authorizer?.jwt?.claims?.sub) {
    return json(401, { error: 'unauthorized' })
  }

  const store = createPublishedS3Store()
  const method = event.requestContext?.http?.method || 'GET'
  const url = new URL(`https://fiapauto.local${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`)

  try {
    if (method === 'GET' && url.pathname === '/manifest') {
      return json(200, await store.readManifest())
    }

    if (method === 'GET' && url.pathname === '/topics') {
      return json(200, await store.readTopics())
    }

    if (method === 'GET' && url.pathname === '/sync/status') {
      const manifest = await store.readManifest()
      return json(200, {
        localReleaseId: undefined,
        localPublishedAt: undefined,
        remoteReleaseId: manifest.releaseId,
        remotePublishedAt: manifest.publishedAt,
        inSync: false,
        bucket: store.config.bucket,
        region: store.config.region,
      })
    }

    if (method === 'GET' && url.pathname === '/assets') {
      const key = url.searchParams.get('key')?.trim() ?? ''
      if (!key) {
        return json(400, { error: 'asset_key_required' })
      }

      const asset = await store.readAsset(key)
      return {
        statusCode: 200,
        isBase64Encoded: true,
        headers: {
          'Content-Type': asset.contentType,
          'Access-Control-Allow-Origin': '*',
        },
        body: asset.buffer.toString('base64'),
      }
    }

    if (method === 'POST' && url.pathname === '/chat/topic') {
      const parsed = JSON.parse(event.body || '{}') as { topicId?: string; question?: string }
      if (!parsed.topicId) {
        return json(400, { error: 'topic_id_required' })
      }
      if (!parsed.question) {
        return json(400, { error: 'question_required' })
      }

      const [topic, chunks] = await Promise.all([store.readTopic(parsed.topicId), store.readChunks()])
      return json(200, answerPublishedTopicQuestion({
        topic,
        chunks,
        question: parsed.question,
      }))
    }

    const topicMatch = url.pathname.match(/^\/topics\/([^/]+)$/)
    if (method === 'GET' && topicMatch) {
      return json(200, await store.readTopic(decodeURIComponent(topicMatch[1]!)))
    }

    return json(404, { error: 'not_found' })
  } catch (error) {
    return json(500, { error: error instanceof Error ? error.message : 'unknown_error' })
  }
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    },
    body: JSON.stringify(body),
  }
}

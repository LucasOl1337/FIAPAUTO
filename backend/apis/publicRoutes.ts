import http from 'node:http'
import {
  askPublishedTopic,
  getPublishedManifest,
  getPublishedSyncStatus,
  getPublishedTopic,
  listPublishedTopics,
  readPublishedAsset,
} from '../public/service.ts'
import {
  listPublicUsersForAdmin,
  readPublicSession,
  signInPublicGuest,
  signInPublicUser,
  signOutPublicSession,
  signUpPublicUser,
  touchPublicSession,
} from '../public/authService.ts'
import { corsHeaders, readJsonBody, requireAdminAccess, sendJson } from './http.ts'

function readBearerToken(request: http.IncomingMessage) {
  const authorization = request.headers.authorization
  if (!authorization?.startsWith('Bearer ')) {
    return ''
  }

  return authorization.slice('Bearer '.length).trim()
}

export async function handlePublicRoutes(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  requestUrl: URL,
) {
  if (request.method === 'POST' && requestUrl.pathname === '/api/public/auth/sign-up') {
    const body = await readJsonBody(request)
    const email = typeof body.email === 'string' ? body.email : ''
    const password = typeof body.password === 'string' ? body.password : ''

    try {
      sendJson(response, 200, await signUpPublicUser({ email, password }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'public_auth_signup_failed'
      sendJson(response, message === 'public_auth_user_exists' ? 409 : 400, { error: message })
    }
    return true
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/public/auth/sign-in') {
    const body = await readJsonBody(request)
    const email = typeof body.email === 'string' ? body.email : ''
    const password = typeof body.password === 'string' ? body.password : ''

    try {
      sendJson(response, 200, await signInPublicUser({ email, password }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'public_auth_signin_failed'
      sendJson(response, 401, { error: message })
    }
    return true
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/public/auth/guest') {
    sendJson(response, 200, await signInPublicGuest())
    return true
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/public/auth/me') {
    const session = await readPublicSession(readBearerToken(request))
    if (!session) {
      sendJson(response, 401, { error: 'public_auth_session_invalid' })
      return true
    }

    sendJson(response, 200, session)
    return true
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/public/auth/ping') {
    const result = await touchPublicSession(readBearerToken(request))
    sendJson(response, result.ok ? 200 : 401, result.ok ? result : { error: 'public_auth_session_invalid' })
    return true
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/public/auth/sign-out') {
    sendJson(response, 200, await signOutPublicSession(readBearerToken(request)))
    return true
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/public/auth/users') {
    if (!requireAdminAccess(request, response)) {
      return true
    }

    sendJson(response, 200, { users: await listPublicUsersForAdmin() })
    return true
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/public/manifest') {
    const manifest = await getPublishedManifest()
    if (!manifest) {
      sendJson(response, 404, { error: 'public_manifest_not_found' })
      return true
    }

    sendJson(response, 200, manifest)
    return true
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/public/topics') {
    sendJson(response, 200, {
      topics: await listPublishedTopics(),
    })
    return true
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/public/assets') {
    const key = requestUrl.searchParams.get('key')?.trim() ?? ''
    if (!key) {
      sendJson(response, 400, { error: 'asset_key_required' })
      return true
    }

    try {
      const asset = await readPublishedAsset(key)
      response.writeHead(200, {
        ...corsHeaders(),
        'Content-Type': asset.contentType,
      })
      response.end(asset.buffer)
    } catch (error) {
      sendJson(response, 404, { error: error instanceof Error ? error.message : 'public_asset_not_found' })
    }
    return true
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/public/sync/status') {
    sendJson(response, 200, await getPublishedSyncStatus())
    return true
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/public/chat/topic') {
    const body = await readJsonBody(request)
    const topicId = typeof body.topicId === 'string' ? body.topicId.trim() : ''
    const question = typeof body.question === 'string' ? body.question.trim() : ''

    if (!topicId) {
      sendJson(response, 400, { error: 'topic_id_required' })
      return true
    }

    if (!question) {
      sendJson(response, 400, { error: 'question_required' })
      return true
    }

    sendJson(response, 200, await askPublishedTopic({ topicId, question }))
    return true
  }

  if (!requestUrl.pathname.startsWith('/api/public/topics/')) {
    return false
  }

  const topicId = decodeURIComponent(requestUrl.pathname.replace('/api/public/topics/', '').split('/')[0] || '')
  if (!topicId) {
    sendJson(response, 400, { error: 'topic_id_required' })
    return true
  }

  if (request.method === 'GET') {
    try {
      sendJson(response, 200, await getPublishedTopic(topicId))
    } catch (error) {
      sendJson(response, 404, { error: error instanceof Error ? error.message : 'public_topic_not_found' })
    }
    return true
  }

  return false
}

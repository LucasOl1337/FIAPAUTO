import http from 'node:http'
import { topicAutomation } from '../automations/botRuntime.ts'
import { readJsonBody, requireAdminAccess, sendJson } from './http.ts'

export async function handleTopicRoutes(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  requestUrl: URL,
) {
  if (request.method === 'GET' && requestUrl.pathname === '/api/topics') {
    sendJson(response, 200, {
      topics: await topicAutomation.syncTopicsFromAssignments(),
    })
    return true
  }

  if (!requestUrl.pathname.startsWith('/api/topics/')) {
    return false
  }

  const topicId = decodeURIComponent(requestUrl.pathname.replace('/api/topics/', '').split('/')[0] || '')
  const basePath = `/api/topics/${encodeURIComponent(topicId)}`
  const suffix = requestUrl.pathname.slice(basePath.length)

  if (!topicId) {
    sendJson(response, 400, { error: 'topic_id_required' })
    return true
  }

  if (request.method === 'GET' && (suffix === '' || suffix === '/')) {
    sendJson(response, 200, await topicAutomation.getTopicById(topicId))
    return true
  }

  if (request.method === 'GET' && suffix === '/debug') {
    if (!requireAdminAccess(request, response)) {
      return true
    }
    sendJson(response, 200, await topicAutomation.getTopicDebug(topicId))
    return true
  }

  if (request.method === 'POST' && suffix === '/generate-summary') {
    if (!requireAdminAccess(request, response)) {
      return true
    }
    const body = await readJsonBody(request)
    sendJson(response, 200, await topicAutomation.generateTopicSummary(topicId, body.force === true))
    return true
  }

  if (request.method === 'POST' && suffix === '/generate-memory') {
    if (!requireAdminAccess(request, response)) {
      return true
    }
    const body = await readJsonBody(request)
    sendJson(response, 200, {
      topicId,
      memory: await topicAutomation.generateTopicMemory(topicId, body.force === true),
    })
    return true
  }

  if (request.method === 'POST' && suffix === '/generate-learning') {
    if (!requireAdminAccess(request, response)) {
      return true
    }
    const body = await readJsonBody(request)
    sendJson(response, 200, {
      topicId,
      learning: await topicAutomation.generateTopicLearning(topicId, body.force === true),
    })
    return true
  }

  if (request.method === 'POST' && suffix === '/ask') {
    const body = await readJsonBody(request)
    const question = typeof body.question === 'string' ? body.question.trim() : ''

    if (!question) {
      sendJson(response, 400, { error: 'question_required' })
      return true
    }

    sendJson(response, 200, await topicAutomation.askTopic({ topicId, question }))
    return true
  }

  return false
}

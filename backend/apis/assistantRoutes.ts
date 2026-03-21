import http from 'node:http'
import { answerAssignmentsQuestion, summarizeAssignment } from '../engine/assignmentAssistant.ts'
import { readJsonBody, sendJson } from './http.ts'

export async function handleAssistantRoutes(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  requestUrl: URL,
) {
  if (request.method === 'POST' && requestUrl.pathname === '/api/assistant/summary') {
    const body = await readJsonBody(request)
    const assignmentId = typeof body.assignmentId === 'string' ? body.assignmentId : ''

    if (!assignmentId) {
      sendJson(response, 400, { error: 'assignment_id_required' })
      return true
    }

    sendJson(response, 200, await summarizeAssignment(assignmentId))
    return true
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/assistant/ask') {
    const body = await readJsonBody(request)
    const question = typeof body.question === 'string' ? body.question.trim() : ''

    if (!question) {
      sendJson(response, 400, { error: 'question_required' })
      return true
    }

    const assignmentId = typeof body.assignmentId === 'string' ? body.assignmentId : undefined
    const moduleKey = typeof body.moduleKey === 'string' ? body.moduleKey : undefined

    sendJson(
      response,
      200,
      await answerAssignmentsQuestion({
        question,
        assignmentId,
        moduleKey,
      }),
    )
    return true
  }

  return false
}

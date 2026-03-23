import http from 'node:http'
import { getPublishedMonitorStatus } from '@fiapauto/server-core/public/service'
import { listPublicUsersForAdmin } from '@fiapauto/server-core/public/auth'
import { requireAdminAccess, sendJson } from '../../../backend/apis/http.ts'

export async function handlePublicAdminRoutes(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  requestUrl: URL,
) {
  if (request.method === 'GET' && requestUrl.pathname === '/api/public/auth/users') {
    if (!requireAdminAccess(request, response)) {
      return true
    }

    sendJson(response, 200, { users: await listPublicUsersForAdmin() })
    return true
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/public/monitor/status') {
    if (!requireAdminAccess(request, response)) {
      return true
    }

    sendJson(response, 200, await getPublishedMonitorStatus())
    return true
  }

  return false
}

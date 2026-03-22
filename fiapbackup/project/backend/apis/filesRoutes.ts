import fs from 'node:fs/promises'
import http from 'node:http'
import { corsHeaders, sendJson } from './http.ts'
import { getContentType, isAllowedRuntimeFile } from '../automations/botRuntime.ts'

export async function handleFilesRoutes(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  requestUrl: URL,
) {
  if (request.method !== 'GET' || requestUrl.pathname !== '/api/files') {
    return false
  }

  const filePath = requestUrl.searchParams.get('path')

  if (!filePath) {
    sendJson(response, 400, { error: 'path_required' })
    return true
  }

  if (!isAllowedRuntimeFile(filePath)) {
    sendJson(response, 403, { error: 'file_path_not_allowed' })
    return true
  }

  const buffer = await fs.readFile(filePath)
  response.writeHead(200, {
    ...corsHeaders(),
    'Content-Type': getContentType(filePath),
  })
  response.end(buffer)
  return true
}

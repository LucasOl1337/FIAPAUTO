import http from 'node:http'

const WEB_ORIGIN = process.env.FIAPAUTO_WEB_ORIGIN || '*'
const ADMIN_TOKEN = process.env.FIAPAUTO_ADMIN_TOKEN?.trim() ?? ''

export function sendJson(response: http.ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(),
  })
  response.end(JSON.stringify(body))
}

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': WEB_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-FIAPAUTO-Admin-Token',
  }
}

export async function readJsonBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (chunks.length === 0) {
    return {}
  }

  const raw = Buffer.concat(chunks).toString('utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

export function readClientIp(request: http.IncomingMessage) {
  const forwardedFor = request.headers['x-forwarded-for']
  const realIp = request.headers['x-real-ip']

  const forwardedValue = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor
  if (typeof forwardedValue === 'string' && forwardedValue.trim()) {
    const [firstIp] = forwardedValue.split(',')
    if (firstIp?.trim()) {
      return firstIp.trim()
    }
  }

  const realValue = Array.isArray(realIp) ? realIp[0] : realIp
  if (typeof realValue === 'string' && realValue.trim()) {
    return realValue.trim()
  }

  return request.socket.remoteAddress?.trim() || ''
}

export function isAdminProtectionEnabled() {
  return ADMIN_TOKEN.length > 0 || process.env.NODE_ENV === 'production'
}

export function requireAdminAccess(request: http.IncomingMessage, response: http.ServerResponse) {
  if (!isAdminProtectionEnabled()) {
    return true
  }

  if (!ADMIN_TOKEN) {
    sendJson(response, 503, { error: 'admin_token_not_configured' })
    return false
  }

  const headerToken = request.headers['x-fiapauto-admin-token']
  const bearerToken = request.headers.authorization?.startsWith('Bearer ')
    ? request.headers.authorization.slice('Bearer '.length).trim()
    : ''
  const providedToken = (Array.isArray(headerToken) ? headerToken[0] : headerToken)?.trim() || bearerToken

  if (providedToken !== ADMIN_TOKEN) {
    sendJson(response, 401, { error: 'admin_unauthorized' })
    return false
  }

  return true
}

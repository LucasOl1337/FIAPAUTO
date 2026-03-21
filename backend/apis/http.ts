import http from 'node:http'

const WEB_ORIGIN = process.env.FIAPAUTO_WEB_ORIGIN || '*'

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
    'Access-Control-Allow-Headers': 'Content-Type',
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

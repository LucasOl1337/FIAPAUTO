import http from 'node:http'
import net from 'node:net'
import { corsHeaders, sendJson } from '../../../backend/apis/http.ts'
import { loadBackendEnv } from '@fiapauto/server-core/config/loadEnv'
import { runtimePaths } from '@fiapauto/server-core/config/runtimePaths'
import { readJsonFile, writeJsonFile } from '@fiapauto/server-core/database/fs'
import { handlePublicApiRoutes } from './routes.ts'

loadBackendEnv()

const HOST = process.env.FIAPAUTO_PUBLIC_API_HOST || process.env.FIAPAUTO_API_HOST || '127.0.0.1'
const DEFAULT_PORT = 43872

function parsePort(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback
}

async function isPortFree(port: number) {
  return await new Promise<boolean>((resolve) => {
    const tester = net.createServer()
    tester.unref()
    tester.once('error', () => resolve(false))
    tester.once('listening', () => {
      tester.close(() => resolve(true))
    })
    tester.listen({ host: HOST, port })
  })
}

async function resolveApiPort(preferredPort: number) {
  for (let candidate = preferredPort; candidate < preferredPort + 200; candidate += 1) {
    if (await isPortFree(candidate)) {
      return candidate
    }
  }

  throw new Error(`no_available_port_from_${preferredPort}`)
}

const resolvedPort = await resolveApiPort(parsePort(process.env.FIAPAUTO_PUBLIC_API_PORT, DEFAULT_PORT))

const server = http.createServer(async (request, response) => {
  try {
    if (!request.url || !request.method) {
      sendJson(response, 400, { error: 'invalid_request' })
      return
    }

    const requestUrl = new URL(request.url, `http://${request.headers.host || `${HOST}:${resolvedPort}`}`)

    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders())
      response.end()
      return
    }

    if (await handlePublicApiRoutes(request, response, requestUrl)) {
      return
    }

    sendJson(response, 404, { error: 'not_found' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown_error'
    sendJson(response, 500, { error: message })
  }
})

server.listen(resolvedPort, HOST, () => {
  void readJsonFile<Record<string, unknown>>(runtimePaths.devPortsFile, {}).then((current) =>
    writeJsonFile(runtimePaths.devPortsFile, {
      ...current,
      host: HOST,
      publicApiPort: resolvedPort,
      publicApiUrl: `http://${HOST}:${resolvedPort}`,
      updatedAt: new Date().toISOString(),
    }),
  )
  console.log(`[public-api] listening on http://${HOST}:${resolvedPort}`)
})

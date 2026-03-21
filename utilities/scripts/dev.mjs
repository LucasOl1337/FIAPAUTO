import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..', '..')
const runtimeDir = path.join(rootDir, 'backend', 'runtime')
const devPortsFile = path.join(runtimeDir, 'dev-ports.json')
const host = '127.0.0.1'
const defaultWebPort = 43871
const defaultApiPort = 43872

function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback
}

function getWorkspaceCommand(workspace) {
  if (process.platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `npm run dev -w ${workspace}`],
    }
  }

  return {
    command: 'npm',
    args: ['run', 'dev', '-w', workspace],
  }
}

async function isPortFree(port) {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen({ host, port })
  })
}

async function findAvailablePort(preferredPort, blockedPorts = new Set()) {
  for (let candidate = preferredPort; candidate < preferredPort + 200; candidate += 1) {
    if (blockedPorts.has(candidate)) continue
    if (await isPortFree(candidate)) return candidate
  }

  throw new Error(`Nenhuma porta livre encontrada a partir de ${preferredPort}.`)
}

function prefixStream(stream, label) {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.length > 0) {
        console.log(`[${label}] ${line}`)
      }
    }
  })
  stream.on('end', () => {
    if (buffer.length > 0) {
      console.log(`[${label}] ${buffer}`)
    }
  })
}

async function writeDevPortsFile(ports) {
  await fs.mkdir(runtimeDir, { recursive: true })
  await fs.writeFile(devPortsFile, JSON.stringify(ports, null, 2), 'utf8')
}

const preferredWebPort = parsePort(process.env.FIAPAUTO_WEB_PORT, defaultWebPort)
const preferredApiPort = parsePort(process.env.FIAPAUTO_API_PORT, defaultApiPort)
const apiPort = await findAvailablePort(preferredApiPort)
const webPort = await findAvailablePort(preferredWebPort, new Set([apiPort]))

await writeDevPortsFile({
  host,
  webPort,
  apiPort,
  frontendUrl: `http://${host}:${webPort}`,
  apiUrl: `http://${host}:${apiPort}`,
  updatedAt: new Date().toISOString(),
})

console.log(`[dev] frontend: http://${host}:${webPort}`)
console.log(`[dev] backend: http://${host}:${apiPort}`)

const sharedEnv = {
  ...process.env,
  FIAPAUTO_WEB_PORT: String(webPort),
  FIAPAUTO_API_PORT: String(apiPort),
  FIAPAUTO_WEB_ORIGIN: `http://${host}:${webPort}`,
  VITE_API_PROXY_TARGET: `http://${host}:${apiPort}`,
}

const children = new Set()
let shuttingDown = false

function spawnWorkspace(label, workspace) {
  const command = getWorkspaceCommand(workspace)
  const child = spawn(command.command, command.args, {
    cwd: rootDir,
    env: sharedEnv,
    stdio: ['inherit', 'pipe', 'pipe'],
  })

  children.add(child)
  prefixStream(child.stdout, label)
  prefixStream(child.stderr, label)

  child.on('exit', (code, signal) => {
    children.delete(child)

    if (shuttingDown) return

    shuttingDown = true
    for (const current of children) {
      current.kill('SIGTERM')
    }

    if (signal) {
      process.exitCode = 1
      console.error(`[dev] ${label} encerrado por sinal ${signal}.`)
      return
    }

    process.exitCode = code ?? 0
    if ((code ?? 0) !== 0) {
      console.error(`[dev] ${label} saiu com codigo ${code}.`)
    }
  })

  return child
}

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    child.kill('SIGTERM')
  }
  console.log(`[dev] encerrando ambiente (${signal})...`)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

spawnWorkspace('api', '@fiapauto/backend')
spawnWorkspace('web', '@fiapauto/frontend')

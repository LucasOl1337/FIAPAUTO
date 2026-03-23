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

const profile = (process.argv[2] || 'all').trim().toLowerCase()

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
    if (blockedPorts.has(candidate)) {
      continue
    }
    if (await isPortFree(candidate)) {
      return candidate
    }
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

const preferredPublicWebPort = parsePort(process.env.FIAPAUTO_PUBLIC_WEB_PORT, 43871)
const preferredPublicApiPort = parsePort(process.env.FIAPAUTO_PUBLIC_API_PORT, 43872)
const preferredAdminWebPort = parsePort(process.env.FIAPAUTO_ADMIN_WEB_PORT, 43873)
const preferredAdminApiPort = parsePort(process.env.FIAPAUTO_ADMIN_API_PORT, 43874)

const blockedPorts = new Set()
const publicApiPort = await findAvailablePort(preferredPublicApiPort, blockedPorts)
blockedPorts.add(publicApiPort)
const publicWebPort = await findAvailablePort(preferredPublicWebPort, blockedPorts)
blockedPorts.add(publicWebPort)
const adminApiPort = await findAvailablePort(preferredAdminApiPort, blockedPorts)
blockedPorts.add(adminApiPort)
const adminWebPort = await findAvailablePort(preferredAdminWebPort, blockedPorts)
blockedPorts.add(adminWebPort)

const publicApiUrl = `http://${host}:${publicApiPort}`
const publicWebUrl = `http://${host}:${publicWebPort}`
const adminApiUrl = `http://${host}:${adminApiPort}`
const adminWebOrigin = `http://${host}:${adminWebPort}`
const adminWebUrl = `${adminWebOrigin}/admin/`

await writeDevPortsFile({
  host,
  publicWebPort,
  publicApiPort,
  adminWebPort,
  adminApiPort,
  publicWebUrl,
  publicApiUrl,
  adminWebUrl,
  adminApiUrl,
  updatedAt: new Date().toISOString(),
})

console.log(`[dev] public web: ${publicWebUrl}`)
console.log(`[dev] public api: ${publicApiUrl}`)
console.log(`[dev] admin web: ${adminWebUrl}`)
console.log(`[dev] admin api: ${adminApiUrl}`)

const sharedEnv = {
  ...process.env,
  FIAPAUTO_PUBLIC_WEB_PORT: String(publicWebPort),
  FIAPAUTO_PUBLIC_API_PORT: String(publicApiPort),
  FIAPAUTO_PUBLIC_WEB_ORIGIN: publicWebUrl,
  FIAPAUTO_PUBLIC_API_BASE_URL: publicApiUrl,
  FIAPAUTO_ADMIN_WEB_PORT: String(adminWebPort),
  FIAPAUTO_ADMIN_API_PORT: String(adminApiPort),
  FIAPAUTO_ADMIN_WEB_ORIGIN: adminWebOrigin,
  FIAPAUTO_WEB_ORIGIN: adminWebOrigin,
  VITE_PUBLIC_API_BASE_URL: publicApiUrl,
  VITE_PUBLIC_API_PORT: String(publicApiPort),
  VITE_ADMIN_API_BASE_URL: adminApiUrl,
  VITE_ADMIN_API_PORT: String(adminApiPort),
  VITE_API_BASE_URL: adminApiUrl,
  VITE_API_PORT: String(adminApiPort),
}

const children = new Set()
let shuttingDown = false

function spawnWorkspace(label, workspace, extraEnv = {}) {
  const command = getWorkspaceCommand(workspace)
  const child = spawn(command.command, command.args, {
    cwd: rootDir,
    env: {
      ...sharedEnv,
      ...extraEnv,
    },
    stdio: ['inherit', 'pipe', 'pipe'],
  })

  children.add(child)
  prefixStream(child.stdout, label)
  prefixStream(child.stderr, label)

  child.on('exit', (code, signal) => {
    children.delete(child)

    if (shuttingDown) {
      return
    }

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
}

function shutdown(signal) {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  for (const child of children) {
    child.kill('SIGTERM')
  }
  console.log(`[dev] encerrando ambiente (${signal})...`)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

if (profile === 'all' || profile === 'public') {
  spawnWorkspace('public-api', '@fiapauto/public-api', {
    FIAPAUTO_PUBLISHED_SOURCE: process.env.FIAPAUTO_PUBLISHED_SOURCE || 'repo',
    FIAPAUTO_WEB_ORIGIN: publicWebUrl,
  })
  spawnWorkspace('public-web', '@fiapauto/web-public')
}

if (profile === 'all' || profile === 'admin') {
  spawnWorkspace('admin-api', '@fiapauto/admin-api', {
    FIAPAUTO_WEB_ORIGIN: adminWebOrigin,
  })
  spawnWorkspace('admin-web', '@fiapauto/web-admin')
}

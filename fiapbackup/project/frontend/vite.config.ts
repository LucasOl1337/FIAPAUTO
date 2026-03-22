import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const devPortsFile = path.resolve(__dirname, '..', 'backend', 'runtime', 'dev-ports.json')

function parsePort(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback
}

function readPersistedApiPort() {
  try {
    const raw = fs.readFileSync(devPortsFile, 'utf8')
    const parsed = JSON.parse(raw) as { apiPort?: number }
    return typeof parsed.apiPort === 'number' ? parsed.apiPort : undefined
  } catch {
    return undefined
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const webPort = parsePort(env.FIAPAUTO_WEB_PORT, 43871)
  const apiPort = parsePort(env.FIAPAUTO_API_PORT, readPersistedApiPort() ?? 43872)
  const apiTarget = env.VITE_API_PROXY_TARGET || `http://127.0.0.1:${apiPort}`

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: webPort,
      strictPort: false,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    preview: {
      host: '127.0.0.1',
      port: webPort,
      strictPort: false,
    },
  }
})

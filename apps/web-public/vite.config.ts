import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..')

function parsePort(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const webPort = parsePort(env.FIAPAUTO_PUBLIC_WEB_PORT, 43871)
  const apiPort = parsePort(env.FIAPAUTO_PUBLIC_API_PORT, 43872)
  const apiTarget = env.VITE_PUBLIC_API_BASE_URL || `http://127.0.0.1:${apiPort}`

  return {
    base: '/',
    plugins: [react()],
    publicDir: path.resolve(repoRoot, 'frontend', 'public'),
    server: {
      host: '127.0.0.1',
      port: webPort,
      strictPort: false,
      fs: {
        allow: [repoRoot],
      },
      proxy: {
        '/api/public': {
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

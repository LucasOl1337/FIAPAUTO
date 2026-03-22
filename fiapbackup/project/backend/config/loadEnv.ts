import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const backendRootDir = path.resolve(__dirname, '..')

let envLoaded = false

export function loadBackendEnv() {
  if (envLoaded) {
    return
  }

  for (const fileName of ['.env', '.env.local']) {
    loadEnvFile(path.join(backendRootDir, fileName))
  }

  envLoaded = true
}

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return
  }

  const source = fs.readFileSync(filePath, 'utf8')
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    const rawValue = line.slice(separatorIndex + 1).trim()
    if (!key || process.env[key] !== undefined) {
      continue
    }

    process.env[key] = stripQuotes(rawValue)
  }
}

function stripQuotes(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }

  return value
}

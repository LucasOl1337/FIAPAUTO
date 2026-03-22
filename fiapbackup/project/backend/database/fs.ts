import fs from 'node:fs/promises'
import path from 'node:path'

export async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true })
}

export async function writeJsonFile(filePath: string, data: unknown) {
  await ensureDir(path.dirname(filePath))
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

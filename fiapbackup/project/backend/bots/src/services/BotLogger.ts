import fs from 'node:fs/promises'
import path from 'node:path'
import { ensureDir } from '../../../database/fs.ts'

export class BotLogger {
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async info(message: string) {
    await this.write('INFO', message)
  }

  async warn(message: string) {
    await this.write('WARN', message)
  }

  async error(message: string) {
    await this.write('ERROR', message)
  }

  async reset() {
    await ensureDir(path.dirname(this.filePath))
    await fs.writeFile(this.filePath, '', 'utf-8')
  }

  async readLines(limit = 60) {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      return raw
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .slice(-limit)
    } catch {
      return []
    }
  }

  private async write(level: 'INFO' | 'WARN' | 'ERROR', message: string) {
    await ensureDir(path.dirname(this.filePath))
    const line = `[${new Date().toISOString()}] ${level} ${message}\n`
    await fs.appendFile(this.filePath, line, 'utf-8')
  }
}

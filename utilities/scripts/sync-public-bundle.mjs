import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..')
const sourceDir = path.join(repoRoot, 'backend', 'runtime', 'public-sync', 'current')
const outputDir = path.join(repoRoot, 'frontend', 'public', 'published')

await fs.rm(outputDir, { recursive: true, force: true })
await fs.mkdir(path.dirname(outputDir), { recursive: true })
await fs.cp(sourceDir, outputDir, { recursive: true })

console.log(outputDir)

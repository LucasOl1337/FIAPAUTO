import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..')
const zipPath = path.join(repoRoot, 'aws', 'dist', 'public-api.zip')
const backendRoot = path.join(repoRoot, 'backend')

loadEnvFile(path.join(backendRoot, '.env'))
loadEnvFile(path.join(backendRoot, '.env.local'))

const bucket = process.env.FIAPAUTO_PUBLIC_BUCKET?.trim() ?? ''
const region = process.env.FIAPAUTO_AWS_REGION?.trim() ?? process.env.AWS_REGION?.trim() ?? ''
const key = (process.env.FIAPAUTO_LAMBDA_ARTIFACT_KEY?.trim() ?? 'artifacts/public-api.zip').replace(/^\/+/, '')

if (!bucket) {
  throw new Error('FIAPAUTO_PUBLIC_BUCKET_not_configured')
}

if (!region) {
  throw new Error('FIAPAUTO_AWS_REGION_not_configured')
}

const body = await fs.readFile(zipPath)
const client = new S3Client({ region })

await client.send(new PutObjectCommand({
  Bucket: bucket,
  Key: key,
  Body: body,
  ContentType: 'application/zip',
}))

console.log(JSON.stringify({
  bucket,
  region,
  key,
  uploadedFrom: zipPath,
}, null, 2))

function loadEnvFile(filePath) {
  if (!fsSync.existsSync(filePath)) {
    return
  }

  const source = fsSync.readFileSync(filePath, 'utf8')
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

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }

  return value
}

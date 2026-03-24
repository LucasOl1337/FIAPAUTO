import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..')

loadEnvFile(path.join(repoRoot, 'backend', '.env'))
loadEnvFile(path.join(repoRoot, 'backend', '.env.local'))
loadEnvFile(path.join(repoRoot, 'aws', '.env.public-api'))
loadEnvFile(path.join(repoRoot, 'aws', '.env.public-api.local'))

const stackName = process.env.FIAPAUTO_PUBLIC_API_STACK_NAME?.trim() || 'fiapauto-public-api'
const publicBucket = requiredEnv('FIAPAUTO_PUBLIC_BUCKET')
const artifactBucket = process.env.FIAPAUTO_LAMBDA_ARTIFACT_BUCKET?.trim() || publicBucket
const artifactKey = (process.env.FIAPAUTO_LAMBDA_ARTIFACT_KEY?.trim() || 'artifacts/public-api.zip').replace(/^\/+/, '')
const executionRoleArn = requiredEnv('FIAPAUTO_LAMBDA_EXECUTION_ROLE_ARN')
const frontendOrigin = requiredEnv('FIAPAUTO_FRONTEND_ORIGIN')
const region = process.env.FIAPAUTO_AWS_REGION?.trim() ?? process.env.AWS_REGION?.trim() ?? 'us-east-1'

run('npm', ['run', 'cloud:prepare:public-api'])
run('node', ['aws/scripts/upload-public-api-artifact.mjs'])
run('aws', [
  'cloudformation',
  'deploy',
  '--region',
  region,
  '--stack-name',
  stackName,
  '--template-file',
  'aws/template.yaml',
  '--parameter-overrides',
  `PublicBucketName=${publicBucket}`,
  `LambdaArtifactBucket=${artifactBucket}`,
  `LambdaArtifactKey=${artifactKey}`,
  `ExistingLambdaExecutionRoleArn=${executionRoleArn}`,
  `FrontendOrigin=${frontendOrigin}`,
])

const output = spawnSync(commandName('aws'), [
  'cloudformation',
  'describe-stacks',
  '--region',
  region,
  '--stack-name',
  stackName,
  '--query',
  "Stacks[0].Outputs[?OutputKey=='PublicApiBaseUrl'].OutputValue | [0]",
  '--output',
  'text',
], {
  cwd: repoRoot,
  encoding: 'utf8',
  shell: process.platform === 'win32',
})

if (output.status !== 0) {
  process.exit(output.status ?? 1)
}

console.log(output.stdout.trim())

function run(command, args) {
  const result = spawnSync(commandName(command), args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function commandName(command) {
  if (process.platform === 'win32' && command === 'npm') {
    return 'npm.cmd'
  }
  return command
}

function requiredEnv(key) {
  const value = process.env[key]?.trim()
  if (!value) {
    throw new Error(`${key}_not_configured`)
  }
  return value
}

function loadEnvFile(filePath) {
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

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }

  return value
}

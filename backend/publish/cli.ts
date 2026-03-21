import { loadBackendEnv } from '../config/loadEnv.ts'
import { preparePublicBundle } from './service.ts'
import { pullCurrentBundleFromS3, pushCurrentBundleToS3, readLocalOnlyStatus, readPublishStatus } from './s3Sync.ts'

loadBackendEnv()

const command = process.argv[2]

async function main() {
  if (command === 'prepare') {
    const prepared = await preparePublicBundle()
    console.log(JSON.stringify({
      status: 'prepared',
      releaseId: prepared.manifest.releaseId,
      publishedAt: prepared.manifest.publishedAt,
      topicCount: prepared.manifest.topicCount,
      attachmentCount: prepared.manifest.attachmentCount,
      knowledgeChunkCount: prepared.manifest.knowledgeChunkCount,
      currentDir: prepared.currentDir,
    }, null, 2))
    return
  }

  if (command === 'push') {
    const result = await pushCurrentBundleToS3()
    console.log(JSON.stringify({
      status: 'pushed',
      ...result,
    }, null, 2))
    return
  }

  if (command === 'pull') {
    const result = await pullCurrentBundleFromS3()
    console.log(JSON.stringify({
      status: 'pulled',
      ...result,
    }, null, 2))
    return
  }

  if (command === 'status') {
    try {
      const status = await readPublishStatus()
      console.log(JSON.stringify(status, null, 2))
      return
    } catch {
      const localStatus = await readLocalOnlyStatus()
      console.log(JSON.stringify(localStatus, null, 2))
      return
    }
  }

  throw new Error(`unsupported_publish_command:${command || 'missing'}`)
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exitCode = 1
})

import { botConfig, createDemoJobs } from '@fiapauto/bots'
import { TeamsWorkspaceStore } from '../database/TeamsWorkspaceStore.ts'
import { writeJsonFile } from '../database/fs.ts'
import { Scheduler } from './Scheduler.ts'
import { createBotOrchestrator } from './botRuntime.ts'

async function main() {
  const command = process.argv[2] ?? 'test'
  const seedJobs = createDemoJobs()
  const scheduler = new Scheduler(createBotOrchestrator(), botConfig.pollIntervalMs)

  if (command === 'worker') {
    console.log('[bot] worker mode started')
    console.log(`[bot] watching jobs every ${botConfig.pollIntervalMs}ms`)
    scheduler.start(seedJobs)
    return
  }

  await writeJsonFile(botConfig.jobsFile, seedJobs)
  await writeJsonFile(botConfig.readyLessonsFile, [])
  await new TeamsWorkspaceStore(botConfig.assignmentsFile).reset()
  const result = await scheduler.runOnce(seedJobs)
  console.log(`[bot] executed jobs: ${result.executedJobs}`)
  console.log(`[bot] jobs state written to: ${botConfig.jobsFile}`)
  console.log(`[bot] ready lessons written to: ${botConfig.readyLessonsFile}`)
}

void main()

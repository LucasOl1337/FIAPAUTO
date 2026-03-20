import { botConfig, createDemoJobs } from './config'
import { Scheduler } from './core/Scheduler'
import { BotOrchestrator } from './core/BotOrchestrator'
import { TeamsMeetingAdapter } from './platforms/teams/TeamsMeetingAdapter'
import { JsonJobRepository } from './services/JsonJobRepository'
import { LocalRecordingService } from './services/LocalRecordingService'
import { LocalTranscriptService } from './services/LocalTranscriptService'
import { BotLogger } from './services/BotLogger'
import { ReadyLessonStore } from './services/ReadyLessonStore'
import { TeamsWorkspaceStore } from './services/TeamsWorkspaceStore'
import { LocalUploadService } from './services/LocalUploadService'
import { writeJsonFile } from './utils/fs'

async function main() {
  const command = process.argv[2] ?? 'test'
  const seedJobs = createDemoJobs()

  const orchestrator = new BotOrchestrator({
    jobsRepository: new JsonJobRepository(botConfig.jobsFile),
    teamsAdapter: new TeamsMeetingAdapter(
      botConfig.screenshotsDir,
      botConfig.headless,
      botConfig.sessionDir,
      botConfig.downloadsDir,
      new BotLogger(botConfig.automationLogFile),
    ),
    recordingService: new LocalRecordingService(botConfig.recordingsDir),
    transcriptService: new LocalTranscriptService(),
    uploadService: new LocalUploadService(botConfig.uploadsDir),
    readyLessonStore: new ReadyLessonStore(botConfig.readyLessonsFile),
  })

  const scheduler = new Scheduler(orchestrator, botConfig.pollIntervalMs)

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

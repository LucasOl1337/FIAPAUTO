import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runtimePaths } from '../../config/runtimePaths.ts'
import type { RecordingJob } from './types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const packageDir = path.resolve(__dirname, '..')

const fixtureUrl = pathToFileURL(path.join(packageDir, 'fixtures', 'mock-teams-meeting.html')).href

export const botConfig = {
  packageDir,
  outputDir: runtimePaths.runtimeDir,
  subjectsDir: runtimePaths.subjectsDir,
  topicsFile: runtimePaths.topicsFile,
  knowledgeDir: runtimePaths.knowledgeDir,
  knowledgeCatalogDir: runtimePaths.knowledgeCatalogDir,
  knowledgeIndexDir: runtimePaths.knowledgeIndexDir,
  knowledgeWarehouseFile: runtimePaths.knowledgeWarehouseFile,
  decisionHistoryFile: runtimePaths.decisionHistoryFile,
  jobsFile: runtimePaths.jobsFile,
  readyLessonsFile: runtimePaths.readyLessonsFile,
  assignmentsFile: runtimePaths.assignmentsFile,
  automationLogFile: runtimePaths.automationLogFile,
  uploadsDir: runtimePaths.uploadsDir,
  recordingsDir: runtimePaths.recordingsDir,
  screenshotsDir: runtimePaths.screenshotsDir,
  downloadsDir: runtimePaths.downloadsDir,
  sessionDir: runtimePaths.sessionDir,
  pollIntervalMs: 15_000,
  headless: readBooleanFlag(process.env.FIAPAUTO_BOT_HEADLESS, false),
}

export function createDemoJobs(): RecordingJob[] {
  const now = Date.now()

  return [
    {
      id: 'job-teams-demo',
      lessonId: 'lesson-teams-demo',
      lessonTitle: 'Teams Demo - IA aplicada',
      discipline: 'Automacao',
      platform: 'teams',
      meetingUrl: fixtureUrl,
      scheduledStart: new Date(now - 60_000).toISOString(),
      scheduledEnd: new Date(now + 30 * 60_000).toISOString(),
      status: 'scheduled',
      retryCount: 0,
      maxRetries: 2,
      captureMode: 'mock',
    },
  ]
}

function readBooleanFlag(value: string | undefined, fallback: boolean) {
  if (value === undefined) {
    return fallback
  }

  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false
  }

  return fallback
}

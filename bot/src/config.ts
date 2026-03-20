import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { RecordingJob } from './types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

const fixtureUrl = pathToFileURL(path.join(rootDir, 'fixtures', 'mock-teams-meeting.html')).href

export const botConfig = {
  rootDir,
  outputDir: path.join(rootDir, 'output'),
  subjectsDir: path.join(rootDir, 'output', 'subjects'),
  topicsFile: path.join(rootDir, 'output', 'subjects', 'topics.json'),
  jobsFile: path.join(rootDir, 'output', 'jobs-state.json'),
  readyLessonsFile: path.join(rootDir, 'output', 'ready-lessons.json'),
  assignmentsFile: path.join(rootDir, 'output', 'assignments-report.json'),
  automationLogFile: path.join(rootDir, 'output', 'automation.log'),
  uploadsDir: path.join(rootDir, 'output', 'uploads'),
  recordingsDir: path.join(rootDir, 'output', 'recordings'),
  screenshotsDir: path.join(rootDir, 'output', 'screenshots'),
  downloadsDir: path.join(rootDir, 'output', 'downloads'),
  sessionDir: path.join(rootDir, 'session', 'teams-profile'),
  pollIntervalMs: 15_000,
  headless: false,
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

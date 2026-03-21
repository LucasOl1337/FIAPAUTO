import fs from 'node:fs/promises'
import path from 'node:path'
import {
  BotLogger,
  BotOrchestrator,
  LocalRecordingService,
  LocalTranscriptService,
  LocalUploadService,
  TeamsMeetingAdapter,
  botConfig,
  createDemoJobs,
  type LiveMeeting,
  type ReadyLessonAsset,
  type RecordingJob,
  type TeamsWorkspaceReport,
} from '@fiapauto/bots'
import type { BotStatusPayload } from '../apis/contracts/index.ts'
import { JsonJobRepository } from '../database/JsonJobRepository.ts'
import { ReadyLessonStore } from '../database/ReadyLessonStore.ts'
import { TeamsWorkspaceStore } from '../database/TeamsWorkspaceStore.ts'
import { ensureDir, readJsonFile, writeJsonFile } from '../database/fs.ts'
import { getLlmStatus } from '../engine/assignmentAssistant.ts'
import {
  askTopic,
  generateTopicMemory,
  generateTopicSummary,
  getTopicById,
  getTopicDebug,
  syncTopicsFromAssignments,
} from '../engine/subjectTopics.ts'
import { getLlmDebugInfo, readLlmDebugHistory } from '../connections/llm/llmDebugStore.ts'
import { runtimePaths } from '../config/runtimePaths.ts'

const logger = new BotLogger(botConfig.automationLogFile)

export function getBotLogger() {
  return logger
}

export function createTeamsAdapter() {
  return new TeamsMeetingAdapter(
    botConfig.screenshotsDir,
    botConfig.headless,
    botConfig.sessionDir,
    botConfig.downloadsDir,
    logger,
  )
}

export function createBotOrchestrator() {
  return new BotOrchestrator({
    jobsRepository: new JsonJobRepository(botConfig.jobsFile),
    teamsAdapter: createTeamsAdapter(),
    recordingService: new LocalRecordingService(botConfig.recordingsDir),
    transcriptService: new LocalTranscriptService(),
    uploadService: new LocalUploadService(botConfig.uploadsDir),
    readyLessonStore: new ReadyLessonStore(botConfig.readyLessonsFile),
  })
}

export async function getBotStatus(): Promise<BotStatusPayload> {
  const adapter = createTeamsAdapter()
  const jobs = await readJsonFile<RecordingJob[]>(botConfig.jobsFile, createDemoJobs())
  const readyLessons = await readJsonFile<ReadyLessonAsset[]>(botConfig.readyLessonsFile, [])
  const storedReport = await new TeamsWorkspaceStore(botConfig.assignmentsFile).read()
  const topics = await syncTopicsFromAssignments()
  const authStatus = await adapter.getSessionAuthStatus()
  const workspaceReport = {
    ...storedReport,
    authStatus,
  }
  const logs = await logger.readLines()

  return {
    jobs,
    readyLessons,
    workspaceReport,
    topics,
    logs,
    llm: getLlmStatus(),
    llmDebug: {
      ...getLlmDebugInfo(),
      events: await readLlmDebugHistory(20),
    },
  }
}

export async function resetBotRuntimeState() {
  await ensureDir(botConfig.outputDir)
  await fs.rm(botConfig.recordingsDir, { recursive: true, force: true })
  await fs.rm(botConfig.uploadsDir, { recursive: true, force: true })
  await fs.rm(botConfig.screenshotsDir, { recursive: true, force: true })
  await fs.rm(botConfig.downloadsDir, { recursive: true, force: true })
  await fs.rm(botConfig.subjectsDir, { recursive: true, force: true })
  await fs.rm(botConfig.knowledgeDir, { recursive: true, force: true })
  await writeJsonFile(botConfig.jobsFile, createDemoJobs())
  await writeJsonFile(botConfig.readyLessonsFile, [])
  await new TeamsWorkspaceStore(botConfig.assignmentsFile).reset()
  await logger.reset()
}

export async function writeWorkspaceReport(report: TeamsWorkspaceReport) {
  await new TeamsWorkspaceStore(botConfig.assignmentsFile).write(report)
}

export async function writeWorkspaceReportFromScan(
  scan: Awaited<ReturnType<TeamsMeetingAdapter['scanWorkspace']>>,
) {
  await writeWorkspaceReport({
    ...scan,
    scannedAt: new Date().toISOString(),
  })
}

export async function failBotAction(action: 'session' | 'test', error: unknown) {
  const message = describeBotError(error)
  await logger.error(`${action} failed: ${message}`)

  if (action === 'session') {
    return {
      connected: false,
      runtimeError: message,
      ...(await getBotStatus()),
    }
  }

  return {
    executedJobs: 0,
    runtimeError: message,
    ...(await getBotStatus()),
  }
}

export function createJobsFromMeetings(meetings: LiveMeeting[]): RecordingJob[] {
  const now = new Date()

  return meetings.map((meeting, index) => ({
    id: `job-live-${slugify(meeting.title)}-${index + 1}`,
    lessonId: `lesson-live-${slugify(meeting.title)}-${index + 1}`,
    lessonTitle: meeting.title,
    discipline: 'Teams ao vivo',
    platform: 'teams',
    meetingUrl: meeting.joinUrl,
    scheduledStart: now.toISOString(),
    scheduledEnd: new Date(now.getTime() + 90 * 60_000).toISOString(),
    status: 'scheduled',
    retryCount: 0,
    maxRetries: 1,
    captureMode: 'browser',
  }))
}

export function describeBotError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)

  if (message.includes('teams_login_required')) {
    return 'teams_login_required'
  }

  if (message.includes('Target page, context or browser has been closed')) {
    return 'teams_browser_closed'
  }

  if (message.includes('assignments_view_not_loaded')) {
    return 'assignments_view_not_loaded'
  }

  return message
}

export function isAllowedRuntimeFile(filePath: string) {
  const normalizedPath = path.resolve(filePath)
  const allowedRoots = [
    runtimePaths.downloadsDir,
    runtimePaths.screenshotsDir,
    runtimePaths.subjectsDir,
    runtimePaths.uploadsDir,
    runtimePaths.recordingsDir,
  ].map((item) => path.resolve(item))

  return allowedRoots.some((root) => normalizedPath.startsWith(root))
}

export function getContentType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase()

  if (extension === '.png') {
    return 'image/png'
  }

  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpeg'
  }

  if (extension === '.webp') {
    return 'image/webp'
  }

  if (extension === '.pdf') {
    return 'application/pdf'
  }

  if (['.txt', '.md', '.py', '.js', '.ts', '.tsx', '.jsx', '.json'].includes(extension)) {
    return 'text/plain; charset=utf-8'
  }

  return 'application/octet-stream'
}

export const topicAutomation = {
  askTopic,
  generateTopicMemory,
  generateTopicSummary,
  getTopicById,
  getTopicDebug,
  syncTopicsFromAssignments,
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

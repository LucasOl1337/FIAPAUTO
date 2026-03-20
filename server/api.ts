import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { botConfig, createDemoJobs } from '../bot/src/config.ts'
import { BotOrchestrator } from '../bot/src/core/BotOrchestrator.ts'
import { TeamsMeetingAdapter } from '../bot/src/platforms/teams/TeamsMeetingAdapter.ts'
import { JsonJobRepository } from '../bot/src/services/JsonJobRepository.ts'
import { LocalRecordingService } from '../bot/src/services/LocalRecordingService.ts'
import { LocalTranscriptService } from '../bot/src/services/LocalTranscriptService.ts'
import { ReadyLessonStore } from '../bot/src/services/ReadyLessonStore.ts'
import { BotLogger } from '../bot/src/services/BotLogger.ts'
import { TeamsWorkspaceStore } from '../bot/src/services/TeamsWorkspaceStore.ts'
import { LocalUploadService } from '../bot/src/services/LocalUploadService.ts'
import { ensureDir, readJsonFile, writeJsonFile } from '../bot/src/utils/fs.ts'
import type {
  LiveMeeting,
  ReadyLessonAsset,
  RecordingJob,
  TeamsWorkspaceReport,
} from '../bot/src/types.ts'
import {
  answerAssignmentsQuestion,
  getLlmStatus,
  summarizeAssignment,
} from './assignmentAssistant.ts'
import { getLlmDebugInfo, readLlmDebugHistory } from './llmDebugStore.ts'
import {
  askTopic,
  generateTopicMemory,
  generateTopicSummary,
  getTopicById,
  getTopicDebug,
  syncTopicsFromAssignments,
} from './subjectTopics.ts'

const PORT = 43872
const logger = new BotLogger(botConfig.automationLogFile)
let scanInProgress = false

process.on('unhandledRejection', (error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error('[api] unhandledRejection', message)
  void logger.error(`unhandledRejection: ${message}`)
})

process.on('uncaughtException', (error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error('[api] uncaughtException', message)
  void logger.error(`uncaughtException: ${message}`)
})

function createOrchestrator() {
  return new BotOrchestrator({
    jobsRepository: new JsonJobRepository(botConfig.jobsFile),
    teamsAdapter: new TeamsMeetingAdapter(
      botConfig.screenshotsDir,
      botConfig.headless,
      botConfig.sessionDir,
      botConfig.downloadsDir,
      logger,
    ),
    recordingService: new LocalRecordingService(botConfig.recordingsDir),
    transcriptService: new LocalTranscriptService(),
    uploadService: new LocalUploadService(botConfig.uploadsDir),
    readyLessonStore: new ReadyLessonStore(botConfig.readyLessonsFile),
  })
}

async function getStatus() {
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

async function readJsonBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (chunks.length === 0) {
    return {}
  }

  const raw = Buffer.concat(chunks).toString('utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

async function resetBotState() {
  await ensureDir(botConfig.outputDir)
  await fs.rm(botConfig.recordingsDir, { recursive: true, force: true })
  await fs.rm(botConfig.uploadsDir, { recursive: true, force: true })
  await fs.rm(botConfig.screenshotsDir, { recursive: true, force: true })
  await fs.rm(botConfig.downloadsDir, { recursive: true, force: true })
  await fs.rm(botConfig.subjectsDir, { recursive: true, force: true })
  await writeJsonFile(botConfig.jobsFile, createDemoJobs())
  await writeJsonFile(botConfig.readyLessonsFile, [])
  await new TeamsWorkspaceStore(botConfig.assignmentsFile).reset()
  await logger.reset()
}

async function failBotAction(action: 'session' | 'test', error: unknown) {
  const message = describeBotError(error)
  await logger.error(`${action} failed: ${message}`)

  if (action === 'session') {
    return {
      connected: false,
      runtimeError: message,
      ...(await getStatus()),
    }
  }

  return {
    executedJobs: 0,
    runtimeError: message,
    ...(await getStatus()),
  }
}

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': 'http://127.0.0.1:43871',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  response.end(JSON.stringify(body))
}

const server = http.createServer(async (request, response) => {
  try {
    if (!request.url || !request.method) {
      sendJson(response, 400, { error: 'invalid_request' })
      return
    }

    const requestUrl = new URL(request.url, `http://${request.headers.host || `127.0.0.1:${PORT}`}`)

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': 'http://127.0.0.1:43871',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      response.end()
      return
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
      sendJson(response, 200, { ok: true })
      return
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/bot/status') {
      sendJson(response, 200, await getStatus())
      return
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/llm/history') {
      const topicId = requestUrl.searchParams.get('topicId') || undefined
      sendJson(response, 200, {
        ...getLlmDebugInfo(),
        events: await readLlmDebugHistory(100, topicId),
      })
      return
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/topics') {
      sendJson(response, 200, {
        topics: await syncTopicsFromAssignments(),
      })
      return
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/files') {
      const filePath = requestUrl.searchParams.get('path')

      if (!filePath) {
        sendJson(response, 400, { error: 'path_required' })
        return
      }

      if (!isAllowedOutputPath(filePath)) {
        sendJson(response, 403, { error: 'file_path_not_allowed' })
        return
      }

      const buffer = await fs.readFile(filePath)
      response.writeHead(200, {
        'Access-Control-Allow-Origin': 'http://127.0.0.1:43871',
        'Content-Type': getContentType(filePath),
      })
      response.end(buffer)
      return
    }

    if (request.method === 'GET' && requestUrl.pathname.startsWith('/api/topics/')) {
      const topicId = decodeURIComponent(requestUrl.pathname.replace('/api/topics/', '').split('/')[0] || '')
      const basePath = `/api/topics/${encodeURIComponent(topicId)}`
      const suffix = requestUrl.pathname.slice(basePath.length)

      if (!topicId) {
        sendJson(response, 400, { error: 'topic_id_required' })
        return
      }

      if (suffix === '' || suffix === '/') {
        sendJson(response, 200, await getTopicById(topicId))
        return
      }

      if (suffix === '/debug') {
        sendJson(response, 200, await getTopicDebug(topicId))
        return
      }
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/bot/session') {
      try {
        const adapter = createTeamsAdapter()
        const scan = await adapter.openSessionWindow()
        await writeWorkspaceReportFromScan(scan)
        sendJson(response, 200, {
          connected: scan.authStatus === 'authenticated',
          ...(await getStatus()),
        })
      } catch (error) {
        sendJson(response, 200, await failBotAction('session', error))
      }
      return
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/bot/test') {
      if (scanInProgress) {
        sendJson(response, 409, { error: 'scan_in_progress', ...(await getStatus()) })
        return
      }

      scanInProgress = true
      try {
        const adapter = createTeamsAdapter()
        const orchestrator = createOrchestrator()
        await logger.info('Execucao solicitada pelo site')
        const scan = await adapter.scanWorkspace()
        await writeWorkspaceReportFromScan(scan)
        await syncTopicsFromAssignments()

        if (scan.authStatus !== 'authenticated') {
          sendJson(response, 200, {
            executedJobs: 0,
            ...(await getStatus()),
          })
          return
        }

        const jobsToRun = scan.liveMeetings.length > 0 ? createJobsFromMeetings(scan.liveMeetings) : []

        const result =
          jobsToRun.length > 0
            ? await orchestrator.runJobs(jobsToRun)
            : { executedJobs: 0, jobs: await readJsonFile<RecordingJob[]>(botConfig.jobsFile, []) }

        sendJson(response, 200, {
          executedJobs: result.executedJobs,
          ...(await getStatus()),
        })
        return
      } catch (error) {
        sendJson(response, 200, await failBotAction('test', error))
        return
      } finally {
        scanInProgress = false
      }
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/bot/reset') {
      await resetBotState()
      sendJson(response, 200, await getStatus())
      return
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/assistant/summary') {
      const body = await readJsonBody(request)
      const assignmentId = typeof body.assignmentId === 'string' ? body.assignmentId : ''

      if (!assignmentId) {
        sendJson(response, 400, { error: 'assignment_id_required' })
        return
      }

      sendJson(response, 200, await summarizeAssignment(assignmentId))
      return
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/assistant/ask') {
      const body = await readJsonBody(request)
      const question = typeof body.question === 'string' ? body.question.trim() : ''

      if (!question) {
        sendJson(response, 400, { error: 'question_required' })
        return
      }

      const assignmentId = typeof body.assignmentId === 'string' ? body.assignmentId : undefined
      const moduleKey = typeof body.moduleKey === 'string' ? body.moduleKey : undefined

      sendJson(
        response,
        200,
        await answerAssignmentsQuestion({
          question,
          assignmentId,
          moduleKey,
        }),
      )
      return
    }

    if (request.method === 'POST' && requestUrl.pathname.startsWith('/api/topics/')) {
      const topicId = decodeURIComponent(requestUrl.pathname.replace('/api/topics/', '').split('/')[0] || '')
      const basePath = `/api/topics/${encodeURIComponent(topicId)}`
      const suffix = requestUrl.pathname.slice(basePath.length)

      if (!topicId) {
        sendJson(response, 400, { error: 'topic_id_required' })
        return
      }

      if (suffix === '/generate-summary') {
        const body = await readJsonBody(request)
        sendJson(response, 200, await generateTopicSummary(topicId, body.force === true))
        return
      }

      if (suffix === '/generate-memory') {
        const body = await readJsonBody(request)
        sendJson(response, 200, {
          topicId,
          memory: await generateTopicMemory(topicId, body.force === true),
        })
        return
      }

      if (suffix === '/ask') {
        const body = await readJsonBody(request)
        const question = typeof body.question === 'string' ? body.question.trim() : ''

        if (!question) {
          sendJson(response, 400, { error: 'question_required' })
          return
        }

        sendJson(response, 200, await askTopic({ topicId, question }))
        return
      }
    }

    sendJson(response, 404, { error: 'not_found' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown_error'
    await logger.error(`request failed: ${message}`)
    sendJson(response, 500, { error: message })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[api] listening on http://127.0.0.1:${PORT}`)
})

function createTeamsAdapter() {
  return new TeamsMeetingAdapter(
    botConfig.screenshotsDir,
    botConfig.headless,
    botConfig.sessionDir,
    botConfig.downloadsDir,
    logger,
  )
}

async function writeWorkspaceReport(report: TeamsWorkspaceReport) {
  await new TeamsWorkspaceStore(botConfig.assignmentsFile).write(report)
}

async function writeWorkspaceReportFromScan(scan: Awaited<ReturnType<TeamsMeetingAdapter['scanWorkspace']>>) {
  await writeWorkspaceReport({
    ...scan,
    scannedAt: new Date().toISOString(),
  })
}

function createJobsFromMeetings(meetings: LiveMeeting[]): RecordingJob[] {
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

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function describeBotError(error: unknown) {
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

function isAllowedOutputPath(filePath: string) {
  const normalizedPath = path.resolve(filePath)
  const allowedRoots = [path.resolve(botConfig.outputDir), path.resolve(botConfig.subjectsDir)]
  return allowedRoots.some((root) => normalizedPath.startsWith(root))
}

function getContentType(filePath: string) {
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

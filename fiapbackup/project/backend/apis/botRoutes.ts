import http from 'node:http'
import { botConfig, type RecordingJob } from '@fiapauto/bots'
import { readJsonFile } from '../database/fs.ts'
import {
  createBotOrchestrator,
  createJobsFromMeetings,
  createTeamsAdapter,
  failBotAction,
  getBotLogger,
  getBotStatus,
  resetBotRuntimeState,
  topicAutomation,
  writeWorkspaceReportFromScan,
} from '../automations/botRuntime.ts'
import { isAdminProtectionEnabled, requireAdminAccess, sendJson } from './http.ts'

type ScanState = {
  value: boolean
}

export async function handleBotRoutes(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  requestUrl: URL,
  scanState: ScanState,
) {
  if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
    sendJson(response, 200, { ok: true, adminProtectionEnabled: isAdminProtectionEnabled() })
    return true
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/bot/status') {
    if (!requireAdminAccess(request, response)) {
      return true
    }
    sendJson(response, 200, await getBotStatus())
    return true
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/bot/session') {
    if (!requireAdminAccess(request, response)) {
      return true
    }
    try {
      const scan = await createTeamsAdapter().openSessionWindow()
      await writeWorkspaceReportFromScan(scan)
      sendJson(response, 200, {
        connected: scan.authStatus === 'authenticated',
        ...(await getBotStatus()),
      })
    } catch (error) {
      sendJson(response, 200, await failBotAction('session', error))
    }
    return true
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/bot/test') {
    if (!requireAdminAccess(request, response)) {
      return true
    }
    if (scanState.value) {
      sendJson(response, 409, { error: 'scan_in_progress', ...(await getBotStatus()) })
      return true
    }

    scanState.value = true

    try {
      const adapter = createTeamsAdapter()
      const orchestrator = createBotOrchestrator()
      await getBotLogger().info('Execucao solicitada pelo site')
      const scan = await adapter.scanWorkspace()
      await writeWorkspaceReportFromScan(scan)
      await topicAutomation.syncTopicsFromAssignments()

      if (scan.authStatus !== 'authenticated') {
        sendJson(response, 200, {
          executedJobs: 0,
          ...(await getBotStatus()),
        })
        return true
      }

      const jobsToRun = scan.liveMeetings.length > 0 ? createJobsFromMeetings(scan.liveMeetings) : []
      const result =
        jobsToRun.length > 0
          ? await orchestrator.runJobs(jobsToRun)
          : { executedJobs: 0, jobs: await readJsonFile<RecordingJob[]>(botConfig.jobsFile, []) }

      sendJson(response, 200, {
        executedJobs: result.executedJobs,
        ...(await getBotStatus()),
      })
    } catch (error) {
      sendJson(response, 200, await failBotAction('test', error))
    } finally {
      scanState.value = false
    }

    return true
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/bot/reset') {
    if (!requireAdminAccess(request, response)) {
      return true
    }
    await resetBotRuntimeState()
    sendJson(response, 200, await getBotStatus())
    return true
  }

  return false
}

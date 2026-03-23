import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const backendRootDir = path.resolve(__dirname, '..')
export const repoRootDir = path.resolve(backendRootDir, '..')

const runtimeDir = path.resolve(process.env.FIAPAUTO_DATA_DIR?.trim() || path.join(backendRootDir, 'runtime'))
const desktopKeysDir = path.join(os.homedir(), 'Desktop', 'KEYS')
const publicSyncDir = path.join(runtimeDir, 'public-sync')

export const runtimePaths = {
  backendRootDir,
  repoRootDir,
  runtimeDir,
  publicSyncDir,
  publicAuthDir: path.join(runtimeDir, 'public-auth'),
  jobsDir: path.join(runtimeDir, 'jobs'),
  logsDir: path.join(runtimeDir, 'logs'),
  downloadsDir: path.join(runtimeDir, 'downloads'),
  screenshotsDir: path.join(runtimeDir, 'screenshots'),
  subjectsDir: path.join(runtimeDir, 'subjects'),
  uploadsDir: path.join(runtimeDir, 'uploads'),
  recordingsDir: path.join(runtimeDir, 'recordings'),
  sessionsDir: path.join(runtimeDir, 'sessions'),
  knowledgeDir: path.join(runtimeDir, 'knowledge'),
  devPortsFile: path.join(runtimeDir, 'dev-ports.json'),
  jobsFile: path.join(runtimeDir, 'jobs', 'jobs-state.json'),
  readyLessonsFile: path.join(runtimeDir, 'jobs', 'ready-lessons.json'),
  assignmentsFile: path.join(runtimeDir, 'jobs', 'assignments-report.json'),
  automationLogFile: path.join(runtimeDir, 'logs', 'automation.log'),
  apiLogFile: path.join(runtimeDir, 'logs', 'api.log'),
  llmDebugHistoryFile: path.join(runtimeDir, 'logs', 'llm-debug-history.jsonl'),
  publicChatEventsFile: path.join(runtimeDir, 'logs', 'public-chat-events.jsonl'),
  publicTrafficSnapshotFile: path.join(runtimeDir, 'logs', 'public-traffic.json'),
  decisionHistoryFile: path.join(runtimeDir, 'logs', 'logic-debug-history.jsonl'),
  llmBridgeLogFile: path.join(runtimeDir, 'logs', 'llm3.log'),
  llmBridgeErrorFile: path.join(runtimeDir, 'logs', 'llm3.err.log'),
  topicsFile: path.join(runtimeDir, 'subjects', 'topics.json'),
  knowledgeCatalogDir: path.join(runtimeDir, 'knowledge', 'catalog'),
  knowledgeIndexDir: path.join(runtimeDir, 'knowledge', 'index'),
  knowledgeWarehouseFile: path.join(runtimeDir, 'knowledge', 'catalog', 'warehouse.json'),
  publicReleasesDir: path.join(publicSyncDir, 'releases'),
  publicCurrentDir: path.join(publicSyncDir, 'current'),
  publicPullDir: path.join(publicSyncDir, 'pulled'),
  publicCurrentReleaseFile: path.join(publicSyncDir, 'current-release.json'),
  publicAuthUsersFile: path.join(runtimeDir, 'public-auth', 'users.json'),
  publicAuthSessionsFile: path.join(runtimeDir, 'public-auth', 'sessions.json'),
  sessionDir: path.join(runtimeDir, 'sessions', 'teams-profile'),
  desktopKeysDir,
  llmKeysLocalFile: path.join(desktopKeysDir, 'llmKeys.local.py'),
  geminiKeysLocalFile: path.join(desktopKeysDir, 'geminiKeys.local'),
  ollamaKeysLocalFile: path.join(desktopKeysDir, 'ollamaKeys.local'),
} as const

export const frontendPaths = {
  frontendRootDir: path.join(repoRootDir, 'frontend'),
} as const

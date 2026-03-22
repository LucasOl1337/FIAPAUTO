export { botConfig, createDemoJobs } from './config.ts'
export type {
  AssignmentItem,
  JoinedMeeting,
  LiveMeeting,
  ReadyLessonAsset,
  RecordingArtifact,
  RecordingJob,
  TeamsScanResult,
  TeamsWorkspaceReport,
  UploadedArtifact,
} from './types.ts'
export { BotOrchestrator } from './core/BotOrchestrator.ts'
export { TeamsMeetingAdapter } from './platforms/teams/TeamsMeetingAdapter.ts'
export { BotLogger } from './services/BotLogger.ts'
export { LocalRecordingService } from './services/LocalRecordingService.ts'
export { LocalTranscriptService } from './services/LocalTranscriptService.ts'
export { LocalUploadService } from './services/LocalUploadService.ts'

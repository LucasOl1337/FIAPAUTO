export type JobStatus =
  | 'scheduled'
  | 'starting'
  | 'joining'
  | 'recording'
  | 'recorded'
  | 'uploading'
  | 'uploaded'
  | 'ready_for_transcription'
  | 'failed'

export interface RecordingJob {
  id: string
  lessonId: string
  lessonTitle: string
  discipline: string
  platform: 'teams'
  meetingUrl: string
  scheduledStart: string
  scheduledEnd?: string
  status: JobStatus
  retryCount: number
  maxRetries: number
  captureMode: 'mock' | 'browser'
}

export interface JoinedMeeting {
  meetingUrl: string
  joinedAt: string
  sessionLabel: string
}

export interface RecordingArtifact {
  jobId: string
  lessonId: string
  localPath: string
  fileName: string
  recordedAt: string
  mimeType: string
}

export interface UploadedArtifact extends RecordingArtifact {
  remoteUrl: string
  uploadedAt: string
}

export interface ReadyLessonAsset {
  lessonId: string
  jobId: string
  lessonTitle: string
  discipline: string
  meetingUrl: string
  recordingUrl: string
  transcriptText: string
  transcriptProvider: string
  transcriptProcessedAt: string
  readyAt: string
  sourcePlatform: 'teams'
}

export interface LiveMeeting {
  title: string
  joinUrl: string
  channel?: string
  detectedAt: string
}

export interface AssignmentItem {
  id: string
  title: string
  dueText: string
  course: string
  status: 'upcoming' | 'late' | 'completed'
  detailUrl?: string
  downloadedFiles: string[]
  screenshotFiles?: string[]
  localFolder?: string
  error?: string
  capturedAt: string
}

export interface TeamsScanResult {
  authStatus: 'authenticated' | 'login_required'
  liveMeetings: LiveMeeting[]
  assignments: AssignmentItem[]
}

export interface TeamsWorkspaceReport extends TeamsScanResult {
  scannedAt: string
}

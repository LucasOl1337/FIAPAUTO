import type { RecordingJob, ReadyLessonAsset } from '../types'
import { ReadyLessonStore } from '../services/ReadyLessonStore'
import { JsonJobRepository } from '../services/JsonJobRepository'
import { LocalRecordingService } from '../services/LocalRecordingService'
import { LocalTranscriptService } from '../services/LocalTranscriptService'
import { LocalUploadService } from '../services/LocalUploadService'
import { TeamsMeetingAdapter } from '../platforms/teams/TeamsMeetingAdapter'

type Dependencies = {
  jobsRepository: JsonJobRepository
  teamsAdapter: TeamsMeetingAdapter
  recordingService: LocalRecordingService
  transcriptService: LocalTranscriptService
  uploadService: LocalUploadService
  readyLessonStore: ReadyLessonStore
}

export class BotOrchestrator {
  private readonly deps: Dependencies

  constructor(deps: Dependencies) {
    this.deps = deps
  }

  async runDueJobs(seedJobs: RecordingJob[]) {
    const jobs = await this.deps.jobsRepository.loadJobs(seedJobs)
    return this.runJobs(jobs)
  }

  async runJobs(jobs: RecordingJob[]) {
    const now = new Date()
    let executedJobs = 0
    const updatedJobs: RecordingJob[] = []

    for (const job of jobs) {
      if (job.status !== 'scheduled') {
        updatedJobs.push(job)
        continue
      }

      const shouldRun = new Date(job.scheduledStart) <= now
      if (!shouldRun) {
        updatedJobs.push(job)
        continue
      }

      executedJobs += 1
      updatedJobs.push(await this.executeJob(job))
    }

    await this.deps.jobsRepository.saveJobs(updatedJobs)
    return { executedJobs, jobs: updatedJobs }
  }

  private async executeJob(job: RecordingJob): Promise<RecordingJob> {
    try {
      const meeting = await this.deps.teamsAdapter.joinMeeting({ ...job, status: 'joining' })
      const artifact = await this.deps.recordingService.record({ ...job, status: 'recording' }, meeting)
      const transcript = await this.deps.transcriptService.transcribe(job, artifact)
      const uploadedArtifact = await this.deps.uploadService.upload(artifact)

      const readyAsset: ReadyLessonAsset = {
        lessonId: job.lessonId,
        jobId: job.id,
        lessonTitle: job.lessonTitle,
        discipline: job.discipline,
        meetingUrl: job.meetingUrl,
        recordingUrl: uploadedArtifact.remoteUrl,
        transcriptText: transcript.text,
        transcriptProvider: transcript.provider,
        transcriptProcessedAt: transcript.processedAt,
        readyAt: new Date().toISOString(),
        sourcePlatform: 'teams',
      }

      await this.deps.readyLessonStore.append(readyAsset)

      return {
        ...job,
        status: 'ready_for_transcription',
      }
    } catch {
      const retryCount = job.retryCount + 1

      return {
        ...job,
        retryCount,
        status: retryCount > job.maxRetries ? 'failed' : 'scheduled',
      }
    }
  }
}

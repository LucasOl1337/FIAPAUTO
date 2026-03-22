import type { RecordingJob } from '../bots/src/types.ts'
import { readJsonFile, writeJsonFile } from './fs.ts'

export class JsonJobRepository {
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async loadJobs(seedJobs: RecordingJob[]) {
    const jobs = await readJsonFile<RecordingJob[]>(this.filePath, seedJobs)

    if (jobs.length === 0) {
      await this.saveJobs(seedJobs)
      return seedJobs
    }

    return jobs
  }

  async saveJobs(jobs: RecordingJob[]) {
    await writeJsonFile(this.filePath, jobs)
  }
}

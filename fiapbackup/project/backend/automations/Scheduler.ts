import type { BotOrchestrator, RecordingJob } from '@fiapauto/bots'

export class Scheduler {
  private readonly orchestrator: BotOrchestrator
  private readonly pollIntervalMs: number

  constructor(
    orchestrator: BotOrchestrator,
    pollIntervalMs: number,
  ) {
    this.orchestrator = orchestrator
    this.pollIntervalMs = pollIntervalMs
  }

  async runOnce(seedJobs: RecordingJob[]) {
    return this.orchestrator.runDueJobs(seedJobs)
  }

  start(seedJobs: RecordingJob[]) {
    const execute = async () => {
      const result = await this.orchestrator.runDueJobs(seedJobs)
      console.log(`[bot] cycle complete - executed jobs: ${result.executedJobs}`)
    }

    void execute()
    const timer = setInterval(() => {
      void execute()
    }, this.pollIntervalMs)

    return () => clearInterval(timer)
  }
}

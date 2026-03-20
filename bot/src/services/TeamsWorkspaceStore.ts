import type { TeamsWorkspaceReport } from '../types'
import { readJsonFile, writeJsonFile } from '../utils/fs'

export class TeamsWorkspaceStore {
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async read() {
    return readJsonFile<TeamsWorkspaceReport>(this.filePath, {
      authStatus: 'login_required',
      liveMeetings: [],
      assignments: [],
      scannedAt: '',
    })
  }

  async write(report: TeamsWorkspaceReport) {
    await writeJsonFile(this.filePath, report)
  }

  async reset() {
    await this.write({
      authStatus: 'login_required',
      liveMeetings: [],
      assignments: [],
      scannedAt: '',
    })
  }
}

import type { TeamsWorkspaceReport } from '../bots/src/types.ts'
import { readJsonFile, writeJsonFile } from './fs.ts'

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

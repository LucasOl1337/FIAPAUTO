import type { ReadyLessonAsset } from '../types'
import { readJsonFile, writeJsonFile } from '../utils/fs'

export class ReadyLessonStore {
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async append(asset: ReadyLessonAsset) {
    const current = await readJsonFile<ReadyLessonAsset[]>(this.filePath, [])
    const next = [...current.filter((item) => item.jobId !== asset.jobId), asset]
    await writeJsonFile(this.filePath, next)
  }
}

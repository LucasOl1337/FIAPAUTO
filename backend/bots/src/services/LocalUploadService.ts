import fs from 'node:fs/promises'
import path from 'node:path'
import type { RecordingArtifact, UploadedArtifact } from '../types'
import { ensureDir } from '../../../database/fs.ts'

export class LocalUploadService {
  private readonly uploadsDir: string

  constructor(uploadsDir: string) {
    this.uploadsDir = uploadsDir
  }

  async upload(artifact: RecordingArtifact): Promise<UploadedArtifact> {
    await ensureDir(this.uploadsDir)

    const targetPath = path.join(this.uploadsDir, artifact.fileName)
    await fs.copyFile(artifact.localPath, targetPath)

    return {
      ...artifact,
      remoteUrl: targetPath,
      uploadedAt: new Date().toISOString(),
    }
  }
}

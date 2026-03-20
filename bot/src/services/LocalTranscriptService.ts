import type { RecordingArtifact, RecordingJob } from '../types'

export type GeneratedTranscript = {
  text: string
  provider: string
  processedAt: string
}

export class LocalTranscriptService {
  private readonly provider = 'Demo Teams Transcript'

  async transcribe(job: RecordingJob, artifact: RecordingArtifact): Promise<GeneratedTranscript> {
    const text = [
      `Transcricao automatica da aula ${job.lessonTitle}.`,
      `Disciplina: ${job.discipline}.`,
      `Fonte da gravacao: ${artifact.fileName}.`,
      'O bot entrou na reuniao do Microsoft Teams, registrou a aula e preparou o conteudo para consulta no site.',
    ].join(' ')

    return {
      text,
      provider: this.provider,
      processedAt: new Date().toISOString(),
    }
  }
}

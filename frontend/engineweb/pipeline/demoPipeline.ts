import type { Fragility, Lesson, Summary, Transcript } from '../types'

const TRANSCRIPT_PROVIDER = 'Demo External STT'
const SUMMARY_PROVIDER = 'Demo External LLM'

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildTranscriptText(lesson: Lesson) {
  return [
    `A aula ${lesson.title} da disciplina ${lesson.discipline} foi processada pelo pipeline de transcricao.`,
    `Os alunos discutiram os conceitos centrais registrados em notas: ${lesson.notes || 'sem observacoes adicionais'}.`,
    'O conteudo destacou exemplos praticos, pontos de revisao e proximos passos para o grupo.',
  ].join(' ')
}

function extractTopics(lesson: Lesson, transcript: Transcript) {
  const rawTopics = [
    lesson.discipline,
    lesson.title.split(' ')[0],
    ...transcript.text
      .replace(/[.,]/g, '')
      .split(' ')
      .filter((word) => word.length > 7)
      .slice(0, 3),
  ]

  return Array.from(new Set(rawTopics)).slice(0, 4)
}

export async function requestTranscriptFromProvider(lesson: Lesson): Promise<Transcript> {
  await delay(1100)

  return {
    id: crypto.randomUUID(),
    lessonId: lesson.id,
    text: buildTranscriptText(lesson),
    status: 'completed',
    provider: TRANSCRIPT_PROVIDER,
    processedAt: new Date().toISOString(),
  }
}

export async function requestSummaryFromProvider(
  lesson: Lesson,
  transcript: Transcript,
): Promise<{ summary: Summary; fragilities: Fragility[] }> {
  await delay(900)

  const topics = extractTopics(lesson, transcript)

  return {
    summary: {
      id: crypto.randomUUID(),
      lessonId: lesson.id,
      topics,
      actions: [
        `Revisar os pontos centrais de ${lesson.discipline}.`,
        `Compartilhar um resumo curto da aula ${lesson.title} com o grupo.`,
      ],
      overview: `Resumo automatico da aula ${lesson.title}, com foco em consolidar conceitos, apoiar revisao e orientar os proximos estudos.`,
      provider: SUMMARY_PROVIDER,
      generatedAt: new Date().toISOString(),
    },
    fragilities: [
      {
        id: crypto.randomUUID(),
        lessonId: lesson.id,
        theme: topics[0] ?? lesson.discipline,
        priority: 'Alta',
        recommendation: `Separar 20 minutos para revisar ${topics[0] ?? lesson.discipline} com exemplos da transcricao.`,
      },
      {
        id: crypto.randomUUID(),
        lessonId: lesson.id,
        theme: topics[1] ?? 'Aplicacao pratica',
        priority: 'Media',
        recommendation: 'Converter o resumo em tarefa ou material compartilhavel para o grupo.',
      },
    ],
  }
}

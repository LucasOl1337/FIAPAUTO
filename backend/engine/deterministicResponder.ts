import type { QuestionIntent } from './questionIntentClassifier.ts'
import type { TopicContextBundle, TopicCitation } from './topicContextBuilder.ts'
import type { SubjectTopic } from './subjectTopics.ts'

export type DeterministicResponse = {
  answer: string
  confidence: 'high' | 'medium' | 'low'
  suggestedQuestions: string[]
  nextSteps: string[]
  citations: TopicCitation[]
}

export function buildDeterministicResponse(input: {
  topic: SubjectTopic
  question: string
  intent: QuestionIntent
  context: TopicContextBundle
}) {
  const answer = selectAnswerByIntent(input.intent, input.context, input.topic)
  return {
    answer,
    confidence: input.context.citations.length >= 2 ? 'high' : 'medium',
    suggestedQuestions: buildSuggestedQuestions(input.intent),
    nextSteps: buildNextSteps(input.intent, input.topic),
    citations: input.context.citations.slice(0, 3),
  } satisfies DeterministicResponse
}

function selectAnswerByIntent(intent: QuestionIntent, context: TopicContextBundle, topic: SubjectTopic) {
  if (intent === 'deadline') {
    return [
      `O prazo principal identificado para ${topic.title} e ${topic.dueText || 'nao encontrado no material'}.`,
      context.deadlineHints[0] ? `No contexto salvo tambem aparece: ${context.deadlineHints[0]}` : '',
      'Se voce for submeter em cima da hora, vale conferir o anexo principal para validar data e horario exatos.',
    ]
      .filter(Boolean)
      .join(' ')
  }

  if (intent === 'deliverable') {
    return [
      `O que aparece como entregavel para ${topic.title}:`,
      ...context.deliverableHints.slice(0, 3).map((item) => `- ${item}`),
    ].join('\n')
  }

  if (intent === 'next_steps') {
    return buildNextSteps(intent, topic).join(' ')
  }

  if (intent === 'numbered_item') {
    if (context.numberedHints.length > 0) {
      const primaryHint = context.numberedHints[0] ?? ''
      return [
        'Encontrei o item que parece corresponder a essa parte do trabalho.',
        `Em resumo: ${primaryHint}`,
        'Se quiser, eu tambem posso transformar isso em um passo a passo bem simples para voce executar.',
      ].join('\n\n')
    }

    return 'Nao encontrei esse item numerado com seguranca no material salvo. Se houver outro anexo ou uma forma diferente de nomear esse item, tente mencionar isso na pergunta.'
  }

  if (intent === 'summary') {
    return context.citations[0]?.snippet || topic.summary || `Ainda nao encontrei um resumo confiavel para ${topic.title}.`
  }

  if (intent === 'grading' || intent === 'format') {
    const penaltyHints = collectPenaltyHints(context)
    if (penaltyHints.length > 0) {
      return [
        'Os principais pontos que podem tirar nota ou gerar problema na entrega sao:',
        ...penaltyHints.slice(0, 4).map((item) => `- ${item}`),
      ].join('\n')
    }

    const source = context.citations.find((item) => item.sourceType === 'content' || item.sourceType === 'faq')
    return source?.snippet || `${topic.title} tem detalhes importantes no enunciado, mas o sistema ainda nao encontrou uma regra objetiva para essa pergunta.`
  }

  return [
    topic.summary || `Este trabalho e ${topic.title}.`,
    context.citations[1]?.snippet || '',
    'Se voce quiser, eu tambem posso transformar isso em checklist, prazo ou entregaveis.',
  ]
    .filter(Boolean)
    .join(' ')
}

function buildNextSteps(intent: QuestionIntent, topic: SubjectTopic) {
  if (intent === 'deliverable' || intent === 'next_steps') {
    return [
      `Confirme o enunciado principal de ${topic.title}.`,
      'Monte uma checklist dos arquivos e requisitos.',
      `Valide o prazo final: ${topic.dueText || 'nao encontrado'}.`,
    ]
  }

  return [
    'Revise o resumo da atividade.',
    'Abra o anexo principal para confirmar detalhes finos.',
    'Pergunte sobre prazo, entregaveis ou criterios se quiser uma resposta mais direta.',
  ]
}

function buildSuggestedQuestions(intent: QuestionIntent) {
  if (intent === 'deadline') {
    return ['O que preciso entregar?', 'Me faca um checklist', 'O que pode me fazer perder pontos?']
  }

  if (intent === 'deliverable') {
    return ['Qual e o prazo?', 'Explique este trabalho de forma simples', 'O que pode me fazer perder pontos?']
  }

  if (intent === 'numbered_item') {
    return ['Explique esse item de forma simples', 'Me diga o passo a passo desse item', 'O que preciso entregar nesse item?']
  }

  return ['O que preciso entregar?', 'Qual e o prazo?', 'Me faca um checklist']
}

function collectPenaltyHints(context: TopicContextBundle) {
  const candidates = [
    ...context.keyFacts,
    ...context.citations.map((item) => item.snippet),
  ]

  return dedupeLines(
    candidates.filter((item) =>
      /\b(descontad|nota zero|ausencia|ausência|atraso|nao sera aceita|não será aceita|item ausente|sem links|abnt|dados ficticios|dados fictícios|penalidade)\b/i.test(item),
    ),
  )
}

function dedupeLines(values: string[]) {
  const seen = new Set<string>()
  return values.filter((item) => {
    const key = item.trim()
    if (!key || seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}

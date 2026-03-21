import { classifyQuestionIntent } from '../engine/questionIntentClassifier.ts'
import type { PublicChatResponse, PublicTopic, PublishedKnowledgeChunk } from '../apis/contracts/index.ts'

type Citation = PublicChatResponse['citations'][number]

export function answerPublishedTopicQuestion(input: {
  topic: PublicTopic
  chunks: PublishedKnowledgeChunk[]
  question: string
}) {
  const intent = classifyQuestionIntent(input.question)
  const scopedChunks = input.chunks.filter((chunk) => chunk.topicId === input.topic.id)
  const citations = rankChunks(scopedChunks, input.question).slice(0, 3).map((chunk) => ({
    sourceType: chunk.sourceType === 'overview' ? 'summary' : chunk.sourceType,
    sourceLabel: `${input.topic.title} / ${chunk.sourceType}`,
    snippet: chunk.text,
  })) satisfies Citation[]

  const answer = buildAnswer({
    topic: input.topic,
    citations,
    intent,
  })

  return {
    topicId: input.topic.id,
    answer,
    confidence: citations.length >= 2 ? 'high' : citations.length === 1 ? 'medium' : 'low',
    strategyUsed: input.topic.agentMemory ? 'memory' : 'deterministic',
    providerUsed: 'local',
    citations,
    suggestedQuestions: buildSuggestedQuestions(intent),
    nextSteps: buildNextSteps(input.topic),
    answeredAt: new Date().toISOString(),
  } satisfies PublicChatResponse
}

function buildAnswer(input: {
  topic: PublicTopic
  citations: Citation[]
  intent: ReturnType<typeof classifyQuestionIntent>
}) {
  if (input.intent === 'deadline') {
    return `O prazo principal identificado para ${input.topic.title} e ${input.topic.dueText || 'nao encontrado no material publicado'}.`
  }

  if (input.intent === 'deliverable') {
    const deliverables = input.topic.agentMemory?.deliverables ?? []
    return deliverables.length > 0
      ? `Os entregaveis publicados para ${input.topic.title} sao: ${deliverables.slice(0, 4).join(', ')}.`
      : 'Os entregaveis nao ficaram totalmente claros no material publicado. Abra o anexo principal para confirmar.'
  }

  if (input.intent === 'summary') {
    return input.topic.summary || input.citations[0]?.snippet || `Ainda nao existe resumo publicado para ${input.topic.title}.`
  }

  if (input.intent === 'next_steps') {
    return buildNextSteps(input.topic).join(' ')
  }

  if (input.intent === 'grading' || input.intent === 'format') {
    const fact = input.topic.agentMemory?.keyFacts.find((item) => /nota|atraso|abnt|formato|links|avali/i.test(item))
    return fact || input.citations[0]?.snippet || 'Nao encontrei uma regra objetiva sobre avaliacao no material publicado.'
  }

  if (input.intent === 'numbered_item' && input.citations[0]) {
    return `O trecho mais relevante que encontrei para esse item foi: ${input.citations[0].snippet}`
  }

  return input.citations[0]?.snippet
    || input.topic.agentMemory?.overview
    || input.topic.summary
    || `Posso te ajudar com ${input.topic.title}. Pergunte sobre prazo, entregaveis ou checklist para eu ser mais objetivo.`
}

function buildNextSteps(topic: PublicTopic) {
  return [
    `Revise o resumo de ${topic.title}.`,
    'Abra o anexo principal para confirmar detalhes finos.',
    `Valide o prazo final: ${topic.dueText || 'nao encontrado'}.`,
  ]
}

function buildSuggestedQuestions(intent: ReturnType<typeof classifyQuestionIntent>) {
  if (intent === 'deadline') {
    return ['O que preciso entregar?', 'Me faca um checklist', 'O que pode me fazer perder pontos?']
  }

  if (intent === 'deliverable') {
    return ['Qual e o prazo?', 'Explique este trabalho de forma simples', 'Me faca um checklist']
  }

  return ['O que preciso entregar?', 'Qual e o prazo?', 'Me faca um checklist']
}

function rankChunks(chunks: PublishedKnowledgeChunk[], question: string) {
  const tokens = tokenize(question)

  return chunks
    .map((chunk) => ({
      chunk,
      score: tokens.reduce((total, token) => {
        let nextTotal = total
        if (chunk.text.toLowerCase().includes(token)) nextTotal += 1
        if (chunk.keywords.includes(token)) nextTotal += 2
        return nextTotal
      }, chunk.sourceType === 'faq' ? 1 : 0),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.chunk)
}

function tokenize(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3 || /^\d+$/.test(item))
}

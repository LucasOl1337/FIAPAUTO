import type { PublicChatResponse, PublicTopic, PublishedKnowledgeChunk } from '@fiapauto/backend/contracts'

type Citation = PublicChatResponse['citations'][number]
type QuestionIntent =
  | 'deadline'
  | 'deliverable'
  | 'format'
  | 'grading'
  | 'numbered_item'
  | 'summary'
  | 'next_steps'
  | 'tool_usage'
  | 'explanation'
  | 'greeting'
  | 'unknown'

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

  const answer = buildStructuredFallback({
    topic: input.topic,
    citations,
    intent,
    question: input.question,
  })

  return {
    topicId: input.topic.id,
    answer,
    confidence: citations.length >= 2 ? 'high' : citations.length === 1 ? 'medium' : 'low',
    strategyUsed: input.topic.agentMemory ? 'memory' : 'deterministic',
    providerUsed: 'local',
    citations,
    suggestedQuestions: buildSuggestedQuestions(intent),
    nextSteps: buildNextSteps(input.topic, input.question, intent),
    answeredAt: new Date().toISOString(),
    qualityStatus: 'fallback',
    qualityReason: 'Resposta entregue pelo fallback local estruturado.',
    answeredByPass: 'local',
  } satisfies PublicChatResponse
}

function classifyQuestionIntent(question: string): QuestionIntent {
  const normalized = normalize(question)
  if (/\b(oi|ola|eai|ae|aee|teste|blz|tudo bem)\b/i.test(normalized)) return 'greeting'
  if (/\b(topico|item|questao|parte|exercicio)\s*(numero\s*)?\d+\b/i.test(normalized)) return 'numbered_item'
  if (/\b(python|script|codigo|programacao|programar|r\b|excel\b|planilha\b|como usar|como aplicar|da para fazer com|usar nisso|usar isso)\b/i.test(normalized)) return 'tool_usage'
  if (/\b(prazo|data|deadline|quando|horario|vence)\b/i.test(normalized)) return 'deadline'
  if (/\b(entregar|entregavel|entregaveis|arquivo|anexo|enviar|subir)\b/i.test(normalized)) return 'deliverable'
  if (/\b(formato|pdf|doc|docx|excel|planilha|slides|apresentacao|abnt)\b/i.test(normalized)) return 'format'
  if (/\b(nota|criterio|avaliacao|perder pontos|erro|penalidade|risco)\b/i.test(normalized)) return 'grading'
  if (/\b(resumo|resumir|sobre o que|objetivo)\b/i.test(normalized)) return 'summary'
  if (/\b(checklist|passos|proximos passos|como comecar|o que fazer|dica|sem dificuldade|como ir bem|como nao errar|como usar)\b/i.test(normalized)) return 'next_steps'
  if (/\b(explica|explique|entenda|ajuda|como funciona|como resolver|nao entendi)\b/i.test(normalized)) return 'explanation'
  return 'unknown'
}

function buildStructuredFallback(input: {
  topic: PublicTopic
  citations: Citation[]
  intent: QuestionIntent
  question: string
}) {
  const deliverables = dedupeItems([
    ...(input.topic.agentMemory?.deliverables ?? []),
    ...input.citations.filter((item) => item.sourceType === 'deliverable').map((item) => item.snippet),
  ]).slice(0, 3)
  const deadline = dedupeItems([
    input.topic.dueText,
    ...(input.topic.agentMemory?.deadlines ?? []),
    ...input.citations
      .filter((item) => item.sourceType === 'deadline' || /prazo|data|horario|vence|entrega/i.test(item.snippet))
      .map((item) => item.snippet),
  ])
  const attention = buildAttentionItems(input.topic, input.citations)
  const nextSteps = buildNextSteps(input.topic, input.question, input.intent)
  const direct = buildDirectFallback({
    topic: input.topic,
    citations: input.citations,
    deliverables,
    deadline,
    intent: input.intent,
    question: input.question,
  })

  return [
    `RESPOSTA DIRETA: ${direct}`,
    `O QUE ENTREGAR: ${formatSectionItems(deliverables, 'Nao encontrei isso no material')}`,
    `PRAZO: ${formatSectionItems(deadline, 'Nao encontrei isso no material')}`,
    `ATENCAO: ${formatSectionItems(attention, 'Nao encontrei isso no material')}`,
    `PROXIMO PASSO: ${formatSectionItems(nextSteps, 'Nao encontrei isso no material')}`,
  ].join('\n')
}

function buildDirectFallback(input: {
  topic: PublicTopic
  citations: Citation[]
  deliverables: string[]
  deadline: string[]
  intent: QuestionIntent
  question: string
}) {
  const normalizedQuestion = normalize(input.question)

  if (input.intent === 'deadline') {
    return input.deadline[0] || 'Nao encontrei um prazo confirmado no material.'
  }

  if (input.intent === 'deliverable') {
    return input.deliverables.length > 0
      ? `Os entregaveis principais desta materia sao ${input.deliverables.join(', ')}.`
      : 'Nao encontrei uma lista fechada de entregaveis no material.'
  }

  if (input.intent === 'grading' || input.intent === 'format') {
    return buildAttentionItems(input.topic, input.citations)[0] || 'Existem pontos de atencao importantes para esta entrega.'
  }

  if (input.intent === 'tool_usage') {
    if (/\bpython\b|\bcodigo\b|\bscript\b/.test(normalizedQuestion)) {
      return 'Python nao aparece como exigencia obrigatoria no material deste trabalho. Se voce quiser usar, trate isso como apoio opcional para organizar ou analisar os dados antes da entrega final.'
    }

    return 'A ferramenta perguntada nao aparece como exigencia obrigatoria no material. Use apenas como apoio opcional ao entregavel final.'
  }

  if (input.intent === 'next_steps' || input.intent === 'explanation' || input.intent === 'unknown') {
    if (/\bpython\b|\bcodigo\b|\bscript\b/.test(normalizedQuestion)) {
      return `Nao encontrei no material nenhuma etapa obrigatoria de programacao para ${input.topic.title}. O foco publicado parece estar nos entregaveis e nas validacoes finais.`
    }

    return `Para avancar em ${input.topic.title} sem se perder, foque primeiro no objetivo principal e siga uma sequencia curta de execucao.`
  }

  return input.citations[0]?.snippet
    || input.topic.agentMemory?.overview
    || input.topic.summary
    || `Vou te ajudar pelo que esta publicado em ${input.topic.title}.`
}

function buildNextSteps(topic: PublicTopic, question: string, intent: QuestionIntent) {
  const steps: string[] = []
  const normalizedQuestion = normalize(question)

  if (/\bpython\b|\bcodigo\b|\bscript\b/.test(normalizedQuestion)) {
    steps.push('Nao invista tempo em codigo antes de confirmar se isso realmente foi pedido neste trabalho.')
    steps.push('Se este for o checkpoint correto, foque primeiro nos entregaveis publicados.')
  }

  if (intent === 'deliverable') {
    steps.push('Monte uma checklist curta dos arquivos que precisam ser enviados.')
  }

  if (intent === 'tool_usage') {
    steps.push('Se quiser usar a ferramenta, use apenas para apoiar a organizacao ou a analise dos dados antes do arquivo final.')
    steps.push('Confirme primeiro o que realmente precisa ser entregue antes de investir tempo nisso.')
  }

  if (intent === 'deadline') {
    steps.push(`Confirme o horario final no material principal: ${topic.dueText || 'nao encontrado'}.`)
  }

  steps.push(`Revise o resumo de ${topic.title}.`)
  steps.push('Abra o anexo principal para validar detalhes finos.')

  return dedupeItems(steps).slice(0, 3)
}

function buildSuggestedQuestions(intent: QuestionIntent) {
  if (intent === 'deadline') {
    return ['O que preciso entregar?', 'Me faca um checklist', 'O que pode me fazer perder pontos?']
  }

  if (intent === 'deliverable') {
    return ['Qual e o prazo?', 'Explique este trabalho de forma simples', 'Me faca um checklist']
  }

  if (intent === 'tool_usage') {
    return ['Isso e obrigatorio ou opcional?', 'Me faca um checklist sem usar codigo', 'Como faco isso sem me perder?']
  }

  return ['O que preciso entregar?', 'Qual e o prazo?', 'Me faca um checklist']
}

function buildAttentionItems(topic: PublicTopic, citations: Citation[]) {
  const fromFacts = (topic.agentMemory?.keyFacts ?? []).filter((item) => /atras|atenc|maximo|zero|abnt|sem|cancela|penalidade|avali|link|nota|erro/i.test(item))
  if (fromFacts.length > 0) {
    return fromFacts.slice(0, 2)
  }

  const fromCitations = citations
    .map((item) => item.snippet)
    .filter((item) => /atras|atenc|maximo|zero|abnt|sem|cancela|penalidade|avali|link|nota|erro/i.test(item))

  if (fromCitations.length > 0) {
    return fromCitations.slice(0, 2)
  }

  return ['Confirme os detalhes finos no anexo principal antes de entregar.']
}

function formatSectionItems(items: string[], fallback: string) {
  const visible = dedupeItems(items)
  if (visible.length === 0) {
    return fallback
  }

  return visible.slice(0, 3).map((item) => `- ${item}`).join(' ')
}

function rankChunks(chunks: PublishedKnowledgeChunk[], question: string) {
  const tokens = tokenize(question)

  return chunks
    .map((chunk) => ({
      chunk,
      score: tokens.reduce((total, token) => {
        let nextTotal = total
        if (normalize(chunk.text).includes(token)) nextTotal += 1
        if (chunk.keywords.map((item) => normalize(item)).includes(token)) nextTotal += 2
        return nextTotal
      }, chunk.sourceType === 'faq' ? 1 : 0),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.chunk)
}

function tokenize(value: string) {
  return normalize(value)
    .split(/[^a-z0-9]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3 || /^\d+$/.test(item))
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function dedupeItems(values: Array<string | undefined>) {
  const seen = new Set<string>()
  const items: string[] = []

  for (const value of values) {
    const cleaned = (value ?? '').replace(/\s+/g, ' ').trim()
    if (!cleaned) {
      continue
    }

    const key = normalize(cleaned)
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    items.push(cleaned)
  }

  return items
}

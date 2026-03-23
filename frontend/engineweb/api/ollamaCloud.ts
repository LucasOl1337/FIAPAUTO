import type { PublicChatResponse, PublicTopic, PublishedKnowledgeChunk } from '@fiapauto/backend/contracts'

const OLLAMA_API_KEY = import.meta.env.VITE_OLLAMA_API_KEY?.trim() ?? ''
const OLLAMA_BASE_URL = (import.meta.env.VITE_OLLAMA_BASE_URL?.trim() || 'https://ollama.com').replace(/\/+$/, '')
const OLLAMA_MODEL =
  import.meta.env.VITE_OLLAMA_MODEL?.trim()
  || import.meta.env.VITE_PUBLIC_LLM_MODEL?.trim()
  || 'qwen3.5:397b-cloud'
const OLLAMA_MAX_IMAGES = Number(import.meta.env.VITE_OLLAMA_MAX_IMAGES ?? '2') || 2

type PublicCloudChatResponse = {
  topicId: string
  answer: string
  sections: PublicChatResponse['sections']
  confidence: 'high' | 'medium' | 'low'
  strategyUsed: 'rag_llm' | 'memory' | 'deterministic'
  providerUsed: 'ollama' | 'local'
  citations: PublicChatResponse['citations']
  suggestedQuestions: string[]
  nextSteps: string[]
  answeredAt: string
  fallbackLevel?: number
  qualityStatus: 'accepted' | 'regenerated' | 'fallback'
  qualityReason: string
  answeredByPass: 'primary' | 'retry' | 'local'
  missingSections?: string[]
}

type ParsedStructuredAnswer = {
  direct: string
  deliverables: string[]
  attention: string[]
  nextSteps: string[]
  extra: string[]
}

type QualityEvaluation = {
  accepted: boolean
  reason: string
  missingSections: string[]
}

export function isOllamaCloudConfigured() {
  return Boolean(OLLAMA_API_KEY)
}

export async function askOllamaCloudTopic(input: {
  topic: PublicTopic
  question: string
  chunks: PublishedKnowledgeChunk[]
  buildAssetUrl: (value: string) => string
}) {
  if (!isOllamaCloudConfigured()) {
    throw new Error('ollama_cloud_not_configured')
  }

  const scopedChunks = input.chunks.filter((chunk) => chunk.topicId === input.topic.id)
  const rankedChunks = rankChunks(scopedChunks, input.question).slice(0, 6)
  const citations = rankedChunks.slice(0, 3).map((chunk) => ({
    sourceType: chunk.sourceType === 'overview' ? 'summary' : chunk.sourceType,
    sourceLabel: `${input.topic.title} / ${chunk.sourceType}`,
    snippet: chunk.text,
  })) satisfies PublicChatResponse['citations']
  const encodedImages = await collectTopicImages(input.topic, input.buildAssetUrl)

  const primaryAnswer = await requestOllamaChat({
    prompt: buildPrompt({
      topic: input.topic,
      question: input.question,
      rankedChunks,
    }),
    encodedImages,
  })

  const primaryEvaluation = evaluateAnswerQuality({
    question: input.question,
    parsed: parseStructuredAnswer(primaryAnswer),
  })

  if (primaryEvaluation.accepted) {
    return buildCloudPayload({
      topic: input.topic,
      question: input.question,
      citations,
      rawAnswer: primaryAnswer,
      qualityStatus: 'accepted',
      qualityReason: primaryEvaluation.reason,
      answeredByPass: 'primary',
      missingSections: primaryEvaluation.missingSections,
    })
  }

  const retryAnswer = await requestOllamaChat({
    prompt: buildRetryPrompt({
      topic: input.topic,
      question: input.question,
      previousAnswer: primaryAnswer,
      qualityReason: primaryEvaluation.reason,
      missingSections: primaryEvaluation.missingSections,
      rankedChunks,
    }),
    encodedImages,
  })

  const retryEvaluation = evaluateAnswerQuality({
    question: input.question,
    parsed: parseStructuredAnswer(retryAnswer),
  })

  return buildCloudPayload({
    topic: input.topic,
    question: input.question,
    citations,
    rawAnswer: retryAnswer,
    qualityStatus: retryEvaluation.accepted ? 'regenerated' : 'fallback',
    qualityReason: retryEvaluation.reason,
    answeredByPass: 'retry',
    missingSections: retryEvaluation.missingSections,
  })
}

function buildCloudPayload(input: {
  topic: PublicTopic
  question: string
  citations: PublicChatResponse['citations']
  rawAnswer: string
  qualityStatus: PublicCloudChatResponse['qualityStatus']
  qualityReason: string
  answeredByPass: PublicCloudChatResponse['answeredByPass']
  missingSections: string[]
}): PublicCloudChatResponse {
  const parsed = parseStructuredAnswer(input.rawAnswer)
  const sections = buildSections(input.topic, input.question, parsed)

  return {
    topicId: input.topic.id,
    answer: normalizeStructuredAnswer(parsed, sections),
    sections,
    confidence: input.citations.length >= 2 ? 'high' : input.citations.length === 1 ? 'medium' : 'low',
    strategyUsed: 'rag_llm',
    providerUsed: 'ollama',
    fallbackLevel: input.qualityStatus === 'fallback' ? 1 : 0,
    citations: input.citations,
    suggestedQuestions: sections.followUpQuestions,
    nextSteps: sections.nextSteps,
    answeredAt: new Date().toISOString(),
    qualityStatus: input.qualityStatus,
    qualityReason: input.qualityReason,
    answeredByPass: input.answeredByPass,
    missingSections: input.missingSections,
  }
}

function buildSections(
  topic: PublicTopic,
  question: string,
  parsed: ParsedStructuredAnswer,
): PublicChatResponse['sections'] {
  const deliverables = buildDeliverableItems(parsed.deliverables, topic)
  const attentionPoints = buildAttentionItems(parsed.attention, topic)
  const nextSteps = buildNextSteps(parsed.nextSteps, topic, question)
  const fullAnswer = dedupeItems([
    parsed.direct,
    ...parsed.extra,
  ]).slice(0, 3)

  return {
    summary10s: buildSummary10s(topic, question, parsed.direct, deliverables),
    fullAnswer: fullAnswer.length > 0 ? fullAnswer : [`Foque no objetivo principal de ${topic.title} e siga o primeiro passo pratico confirmado no material.`],
    deliverables,
    attentionPoints,
    nextSteps,
    followUpQuestions: buildSuggestedQuestions(topic, question),
    answerMode: shouldUseGeneralGuidance(question, parsed, deliverables) ? 'general_guidance' : 'grounded',
  }
}

async function requestOllamaChat(input: { prompt: string; encodedImages: string[] }) {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OLLAMA_API_KEY}`,
    },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      options: {
        temperature: 0.15,
      },
      messages: [
        {
          role: 'user',
          content: input.prompt,
          ...(input.encodedImages.length > 0 ? { images: input.encodedImages } : {}),
        },
      ],
    }),
  })

  const data = (await response.json().catch(() => null)) as
    | {
        message?: {
          content?: string
        }
        error?: string
      }
    | null

  if (!response.ok) {
    throw new Error(data?.error || `ollama_cloud_http_${response.status}`)
  }

  const answer = data?.message?.content?.trim()
  if (!answer) {
    throw new Error('ollama_cloud_empty_response')
  }

  return answer
}

async function collectTopicImages(topic: PublicTopic, buildAssetUrl: (value: string) => string) {
  const imageKeys = topic.screenshots.slice(0, Math.max(0, OLLAMA_MAX_IMAGES))
  const encoded = await Promise.all(
    imageKeys.map(async (key) => {
      try {
        const response = await fetch(buildAssetUrl(key))
        if (!response.ok) {
          return ''
        }
        const buffer = await response.arrayBuffer()
        return encodeArrayBufferToBase64(buffer)
      } catch {
        return ''
      }
    }),
  )

  return encoded.filter(Boolean)
}

function encodeArrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!)
  }
  return window.btoa(binary)
}

function buildPrompt(input: {
  topic: PublicTopic
  question: string
  rankedChunks: PublishedKnowledgeChunk[]
}) {
  const normalizedLearning = normalizeLearning(input.topic.learning)
  const frequentQuestions = (normalizedLearning?.frequentQuestions ?? [])
    .slice(0, 4)
    .map((item) => `- ${item.question}: ${item.answer}`)
    .join('\n')
  const learningTopics = (normalizedLearning?.learningTopics ?? [])
    .slice(0, 3)
    .map((item) => `- ${item.title}: ${item.explanation} Dificuldade comum: ${item.commonDifficulty} Estrategia: ${item.studyStrategy}`)
    .join('\n')
  const quickTips = (normalizedLearning?.quickTips ?? []).slice(0, 4).map((item) => `- ${item}`).join('\n')
  const keyFacts = (input.topic.agentMemory?.keyFacts ?? []).slice(0, 8).map((item) => `- ${item}`).join('\n')
  const knownDeliverables = (input.topic.agentMemory?.deliverables ?? []).slice(0, 4).map((item) => `- ${item}`).join('\n')
  const chunksBlock = input.rankedChunks.map((chunk, index) => `[${index + 1}] ${chunk.sourceType}: ${chunk.text}`).join('\n\n')

  return [
    'Voce e o assistente publico do FiapFlow.',
    'Responda em portugues do Brasil, de forma objetiva, clara, curta e util para um aluno.',
    'Use apenas o contexto fornecido abaixo.',
    'Nunca escreva "nao sei", "nao encontrei isso no material" ou placeholders vazios.',
    'Se faltar um detalhe exato, entregue a melhor orientacao pratica possivel com base no contexto confirmado.',
    'Nunca copie nomes brutos de arquivo, professor, disciplina, semestre ou metadados como se fossem entregaveis.',
    'Nao mencione prazo, data ou horario, a menos que o usuario pergunte isso diretamente.',
    'Nao repita a mesma regra em mais de um bloco.',
    'Se a pergunta fugir da materia, explique de forma geral em 1 ou 2 frases e reconecte com a tarefa atual.',
    'Se a pergunta for muito vaga, peca uma reformulacao curta e sugira o proximo melhor tipo de pergunta.',
    '',
    `Materia: ${input.topic.title}`,
    `Curso: ${input.topic.course}`,
    `Modulo: ${input.topic.moduleKey}`,
    '',
    'Resumo publicado:',
    input.topic.summary || 'Resumo nao publicado.',
    '',
    'Memoria do agente:',
    input.topic.agentMemory?.overview || 'Memoria nao publicada.',
    '',
    'Entregaveis confirmados:',
    knownDeliverables || '- Nenhum entregavel confirmado.',
    '',
    'Fatos importantes:',
    keyFacts || '- Nenhum fato importante confirmado.',
    '',
    'FAQ / aprendizado:',
    frequentQuestions || '- Nenhum FAQ confirmado.',
    '',
    'Topicos de aprendizado:',
    learningTopics || '- Nenhum topico de aprendizado confirmado.',
    '',
    'Dicas rapidas:',
    quickTips || '- Nenhuma dica rapida confirmada.',
    '',
    'Trechos relevantes do material:',
    chunksBlock || 'Nenhum trecho relevante encontrado.',
    '',
    `Pergunta do usuario: ${input.question}`,
    '',
    'Formato obrigatorio da resposta:',
    'RESPOSTA DIRETA:',
    'O QUE ENTREGAR:',
    'ATENCAO:',
    'PROXIMO PASSO:',
    '',
    'Regras do formato:',
    '- Cada bloco deve conter algo util, humano e pronto para aparecer em cards.',
    '- RESPOSTA DIRETA: responda a duvida principal em 1 ou 2 frases curtas.',
    '- O QUE ENTREGAR: liste apenas itens curtos e limpos.',
    '- ATENCAO: liste riscos curtos, um por linha, sem repetir o que ja apareceu.',
    '- PROXIMO PASSO: liste acoes executaveis e objetivas.',
    '- Nao use markdown, tabela, pipe, asterisco, titulo com #, bloco de citacao ou texto decorativo.',
    '- Nao invente dados.',
    '- Se as imagens ajudarem, use-as tambem.',
  ].join('\n')
}

function buildRetryPrompt(input: {
  topic: PublicTopic
  question: string
  previousAnswer: string
  qualityReason: string
  missingSections: string[]
  rankedChunks: PublishedKnowledgeChunk[]
}) {
  return [
    buildPrompt(input),
    '',
    'Sua resposta anterior ficou insuficiente.',
    `Motivo da rejeicao: ${input.qualityReason}`,
    `Blocos faltando ou fracos: ${input.missingSections.join(', ') || 'RESPOSTA DIRETA'}`,
    'Agora corrija com estas exigencias extras:',
    '- Responda primeiro a pergunta real do usuario.',
    '- Remova redundancias.',
    '- Remova qualquer nome bruto de arquivo e qualquer metadado irrelevante.',
    '- Nao devolva texto generico como "para avancar" sem explicar a duvida real.',
    '- Nao corte a resposta com reticencias nem compacte tudo em uma frase gigante.',
    '',
    'Resposta anterior ruim:',
    input.previousAnswer,
  ].join('\n')
}

function buildSuggestedQuestions(topic: PublicTopic, question: string) {
  if (/\b(entregar|arquivo|anexo|enviar)\b/i.test(question)) {
    return ['Me faca um checklist', 'Explique este trabalho de forma simples', 'O que pode me fazer perder pontos?']
  }

  if (/\b(checklist|passo|como comeco)\b/i.test(question)) {
    return ['O que preciso entregar?', 'Explique este trabalho de forma simples', 'O que pode me fazer perder pontos?']
  }

  return [
    `O que preciso entregar em ${topic.title}?`,
    'Me faca um checklist',
    'O que pode me fazer perder pontos?',
  ]
}

function parseStructuredAnswer(answer: string): ParsedStructuredAnswer {
  const lines = answer
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)

  const parsed: ParsedStructuredAnswer = {
    direct: '',
    deliverables: [],
    attention: [],
    nextSteps: [],
    extra: [],
  }

  let currentSection: keyof ParsedStructuredAnswer | null = null

  for (const line of lines) {
    const match = line.match(/^([A-Za-z\s]+):\s*(.*)$/)
    if (match) {
      const section = normalizeSection(match[1] ?? '')
      if (section) {
        currentSection = section
        const inlineValue = sanitizeAnswerText(match[2] ?? '')
        if (inlineValue) {
          pushAnswerValue(parsed, section, inlineValue)
        }
        continue
      }
    }

    const bullet = line.match(/^[-*]\s+(.+)$/)
    if (bullet && currentSection) {
      pushAnswerValue(parsed, currentSection, bullet[1] ?? '')
      continue
    }

    if (currentSection) {
      pushAnswerValue(parsed, currentSection, line)
      continue
    }

    const looseLine = sanitizeAnswerText(line)
    if (looseLine) {
      parsed.extra.push(looseLine)
    }
  }

  return parsed
}

function normalizeStructuredAnswer(parsed: ParsedStructuredAnswer, sections: PublicChatResponse['sections']) {
  return [
    `RESPOSTA DIRETA: ${sanitizeAnswerText(parsed.direct) || sections.summary10s}`,
    `O QUE ENTREGAR: ${formatSectionItems(sections.deliverables, 'Confirme os entregaveis no anexo principal.')}`,
    `ATENCAO: ${formatSectionItems(sections.attentionPoints, 'Valide os criterios finais no material principal antes de enviar.')}`,
    `PROXIMO PASSO: ${formatSectionItems(sections.nextSteps, 'Abra o anexo principal e monte uma checklist curta antes de continuar.')}`,
  ].join('\n')
}

function normalizeSection(value: string): keyof ParsedStructuredAnswer | null {
  const normalized = normalize(value)
  if (/^resposta direta|^resumo/.test(normalized)) return 'direct'
  if (/^o que entregar|^entrega|^entreg/.test(normalized)) return 'deliverables'
  if (/^atencao|^risco/.test(normalized)) return 'attention'
  if (/^proximo passo|^proximos passos|^checklist|^como fazer/.test(normalized)) return 'nextSteps'
  return null
}

function pushAnswerValue(parsed: ParsedStructuredAnswer, section: keyof ParsedStructuredAnswer, value: string) {
  const cleaned = sanitizeAnswerText(value)
  if (!cleaned) {
    return
  }

  if (section === 'direct') {
    parsed.direct = parsed.direct ? `${parsed.direct} ${cleaned}`.trim() : cleaned
    return
  }

  if (!parsed[section].includes(cleaned)) {
    parsed[section].push(cleaned)
  }
}

function sanitizeAnswerText(value: string) {
  return value
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/^[-*]\s*/g, '')
    .replace(/^arquivo:\s*/i, '')
    .replace(/^pontos?\s+de\s+atencao:\s*/i, '')
    .replace(/^atencao:\s*/i, '')
    .replace(/^proximo\s+passo:\s*/i, '')
    .replace(/^o\s+que\s+entregar:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function evaluateAnswerQuality(input: { question: string; parsed: ParsedStructuredAnswer }): QualityEvaluation {
  const missingSections: string[] = []
  const normalizedQuestion = normalize(input.question)
  const direct = sanitizeAnswerText(input.parsed.direct)

  if (!direct || direct.length < 20) {
    missingSections.push('RESPOSTA DIRETA')
  }

  if (containsForbiddenPlaceholder(direct) || containsRawFileNoise(direct)) {
    missingSections.push('RESPOSTA DIRETA')
  }

  if (/\b(entregar|arquivo|anexo|enviar)\b/.test(normalizedQuestion) && buildDeliverableItems(input.parsed.deliverables, null).length === 0) {
    missingSections.push('O QUE ENTREGAR')
  }

  if (/\b(checklist|passo|como|explica|ajuda)\b/.test(normalizedQuestion) && buildNextSteps(input.parsed.nextSteps, null, input.question).length === 0) {
    missingSections.push('PROXIMO PASSO')
  }

  if (buildAttentionItems(input.parsed.attention, null).some((item) => containsRawFileNoise(item))) {
    missingSections.push('ATENCAO')
  }

  return {
    accepted: missingSections.length === 0,
    reason: missingSections.length === 0 ? 'Resposta validada pela IA.' : `Resposta fraca ou ruidosa; revisar ${Array.from(new Set(missingSections)).join(', ')}.`,
    missingSections: Array.from(new Set(missingSections)),
  }
}

function buildSummary10s(topic: PublicTopic, question: string, direct: string, deliverables: string[]) {
  const cleanedDirect = sanitizeAnswerText(direct)
  if (cleanedDirect && cleanedDirect.length <= 180 && !containsRawFileNoise(cleanedDirect)) {
    return cleanedDirect
  }

  if (/\b(entregar|arquivo|anexo|enviar)\b/i.test(question) && deliverables.length > 0) {
    return `Foque nestes entregaveis principais: ${deliverables.join(', ')}.`
  }

  return `Foque no objetivo principal de ${topic.title} e siga o primeiro passo pratico confirmado no material.`
}

function buildDeliverableItems(items: string[], topic: PublicTopic | null) {
  const values = dedupeItems([
    ...items,
    ...((topic?.agentMemory?.deliverables ?? [])),
  ])
    .map(normalizeDeliverableItem)
    .filter(isUsefulDeliverable)

  return dedupeItems(values).slice(0, 3)
}

function buildAttentionItems(items: string[], topic: PublicTopic | null) {
  const values = dedupeItems([
    ...splitCompositeItems(items),
    ...((topic?.agentMemory?.keyFacts ?? []).filter((item) => /atras|atenc|maximo|abnt|dados ficticios|oral|nota zero|cancel/i.test(normalize(item)))),
  ])
    .map(normalizeAttentionItem)
    .filter(isUsefulAttention)

  return values.slice(0, 3)
}

function buildNextSteps(items: string[], topic: PublicTopic | null, question: string) {
  const values = dedupeItems([
    ...splitCompositeItems(items).filter((item) => /\b(abra|monte|prepare|valide|revise|confirme|organize|liste|verifique)\b/i.test(item)),
    ...buildFallbackNextSteps(topic, question),
  ])

  return values.slice(0, 3)
}

function buildFallbackNextSteps(topic: PublicTopic | null, question: string) {
  if (question.trim().length <= 4) {
    return [
      'Reescreva sua pergunta de forma objetiva sobre entrega, checklist ou criterio de avaliacao.',
      'Se quiser, pergunte o que precisa entregar ou o que pode fazer voce perder pontos.',
    ]
  }

  return [
    'Abra o anexo principal para confirmar os detalhes finais.',
    'Monte uma checklist curta do que precisa ser enviado.',
    ...(topic ? [`Revise o objetivo central de ${topic.title} antes de finalizar.`] : []),
  ]
}

function formatSectionItems(items: string[], fallback: string) {
  const visible = dedupeItems(items)
  if (visible.length === 0) {
    return fallback
  }

  return visible.slice(0, 3).map((item) => `- ${item}`).join(' ')
}

function splitCompositeItems(items: string[]) {
  return items.flatMap((item) =>
    sanitizeAnswerText(item)
      .split(/\s*;\s*|\.\s+(?=[A-Z0-9])/)
      .map((part) => sanitizeAnswerText(part))
      .filter(Boolean),
  )
}

function normalizeDeliverableItem(value: string) {
  const cleaned = sanitizeAnswerText(value)
    .replace(/\.(pdf|docx|xlsx|xls)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (/(apresenta|slide)/i.test(cleaned) && /pdf/i.test(value)) return 'Apresentacao em PDF'
  if (/(formular|questionario|pesquisa)/i.test(cleaned) && /pdf/i.test(value)) return 'Formulario ou pesquisa em PDF'
  if (/(base de dados|planilha|excel|xlsx)/i.test(cleaned)) return 'Base de dados em Excel'

  return cleaned
}

function normalizeAttentionItem(value: string) {
  return sanitizeAnswerText(value)
    .replace(/^seguir\s+/i, '')
    .replace(/^pontos?\s+de\s+atencao:\s*/i, '')
}

function isUsefulDeliverable(value: string) {
  const cleaned = sanitizeAnswerText(value)
  if (!cleaned || cleaned.length > 72) {
    return false
  }

  return !containsRawFileNoise(cleaned)
}

function isUsefulAttention(value: string) {
  const cleaned = sanitizeAnswerText(value)
  if (!cleaned || cleaned.length > 120) {
    return false
  }

  return !containsRawFileNoise(cleaned)
}

function containsForbiddenPlaceholder(value: string) {
  return /\bnao sei\b|\bnao encontrei isso no material\b/i.test(value)
}

function containsRawFileNoise(value: string) {
  return /(checkpoint.*docx|arquivo "|disciplina|professor|semestre|1tiapf|tecnologo|statistical computing|rodolfo|curso|modulo)/i.test(value)
}

function shouldUseGeneralGuidance(question: string, parsed: ParsedStructuredAnswer, deliverables: string[]) {
  return question.trim().length <= 4 || (!deliverables.length && /\b(ensina|explica|como funciona)\b/i.test(question) && parsed.direct.length > 0)
}

function dedupeItems(values: string[]) {
  const seen = new Set<string>()
  const items: string[] = []

  for (const value of values) {
    const cleaned = sanitizeAnswerText(value)
    if (!cleaned) {
      continue
    }

    const key = normalize(cleaned)
      .replace(/\batraso superior a 15 minutos cancela entrega\b/g, 'atraso-15')
      .replace(/\bmaximo 6 por grupo\b/g, 'maximo-6')
      .replace(/\bsem dados ficticios\b/g, 'sem-dados-ficticios')
      .replace(/\bausencia na oral gera nota zero\b/g, 'oral-nota-zero')
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    items.push(cleaned)
  }

  return items
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

function normalizeLearning(learning: PublicTopic['learning']) {
  if (!learning) {
    return null
  }

  const legacyTopics = (learning.simpleConcepts ?? [])
    .map((item) => ({
      title: item.title,
      explanation: item.content,
      commonDifficulty: 'Uma dificuldade comum e transformar esse texto em execucao pratica.',
      studyStrategy: 'Use esse ponto como guia e conecte a explicacao com o enunciado antes de agir.',
    }))

  return {
    frequentQuestions: learning.frequentQuestions ?? [],
    learningTopics: learning.learningTopics ?? legacyTopics,
    quickTips: learning.quickTips ?? [],
  }
}

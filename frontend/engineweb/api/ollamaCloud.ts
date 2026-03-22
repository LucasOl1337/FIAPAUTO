import type { PublicChatResponse, PublicTopic, PublishedKnowledgeChunk } from '@fiapauto/backend/contracts'

const OLLAMA_API_KEY = import.meta.env.VITE_OLLAMA_API_KEY?.trim() ?? ''
const OLLAMA_BASE_URL = (import.meta.env.VITE_OLLAMA_BASE_URL?.trim() || 'https://ollama.com').replace(/\/+$/, '')
const OLLAMA_MODEL = import.meta.env.VITE_OLLAMA_MODEL?.trim() || 'gpt-oss:20b'
const OLLAMA_MAX_IMAGES = Number(import.meta.env.VITE_OLLAMA_MAX_IMAGES ?? '2') || 2

type PublicCloudChatResponse = {
  topicId: string
  answer: string
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
  deadline: string[]
  attention: string[]
  nextSteps: string[]
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

  const prompt = buildPrompt({
    topic: input.topic,
    question: input.question,
    rankedChunks,
  })

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
        temperature: 0.2,
      },
      messages: [
        {
          role: 'user',
          content: prompt,
          ...(encodedImages.length > 0 ? { images: encodedImages } : {}),
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

  const primaryEvaluation = evaluateAnswerQuality(input.question, parseStructuredAnswer(answer))
  if (!primaryEvaluation.accepted) {
    const retryAnswer = await requestOllamaChat({
      prompt: buildRetryPrompt({
        topic: input.topic,
        question: input.question,
        previousAnswer: answer,
        qualityReason: primaryEvaluation.reason,
        missingSections: primaryEvaluation.missingSections,
        rankedChunks,
      }),
      encodedImages,
    })
    const retryEvaluation = evaluateAnswerQuality(input.question, parseStructuredAnswer(retryAnswer))
    if (retryEvaluation.accepted) {
      return {
        topicId: input.topic.id,
        answer: normalizeStructuredAnswer(retryAnswer),
        confidence: citations.length >= 2 ? 'high' : citations.length === 1 ? 'medium' : 'low',
        strategyUsed: 'rag_llm',
        providerUsed: 'ollama',
        fallbackLevel: 0,
        citations,
        suggestedQuestions: buildSuggestedQuestions(input.topic),
        nextSteps: parseStructuredAnswer(retryAnswer).nextSteps.slice(0, 3),
        answeredAt: new Date().toISOString(),
        qualityStatus: 'regenerated',
        qualityReason: retryEvaluation.reason,
        answeredByPass: 'retry',
        missingSections: retryEvaluation.missingSections,
      } satisfies PublicCloudChatResponse
    }

    throw new Error('ollama_cloud_quality_failed')
  }

  return {
    topicId: input.topic.id,
    answer: normalizeStructuredAnswer(answer),
    confidence: citations.length >= 2 ? 'high' : citations.length === 1 ? 'medium' : 'low',
    strategyUsed: 'rag_llm',
    providerUsed: 'ollama',
    fallbackLevel: 0,
    citations,
    suggestedQuestions: buildSuggestedQuestions(input.topic),
    nextSteps: parseStructuredAnswer(answer).nextSteps.slice(0, 3),
    answeredAt: new Date().toISOString(),
    qualityStatus: 'accepted',
    qualityReason: primaryEvaluation.reason,
    answeredByPass: 'primary',
    missingSections: primaryEvaluation.missingSections,
  } satisfies PublicCloudChatResponse
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
        temperature: 0.2,
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
  const chunksBlock = input.rankedChunks.map((chunk, index) => `[${index + 1}] ${chunk.sourceType}: ${chunk.text}`).join('\n\n')

  return [
    'Voce e o assistente publico do FIAPAUTO.',
    'Responda em portugues do Brasil, de forma objetiva, clara e util para um aluno.',
    'Evite resposta genérica, cumprimentos longos e texto corrido sem estrutura.',
    'Use apenas o contexto fornecido abaixo. Se algo nao estiver no material, diga explicitamente que nao encontrou.',
    'Se a pergunta for vaga, curta ou for apenas uma saudacao, responda com o resumo mais util da materia em vez de apenas cumprimentar.',
    '',
    `Materia: ${input.topic.title}`,
    `Curso: ${input.topic.course}`,
    `Modulo: ${input.topic.moduleKey}`,
    `Status: ${input.topic.status}`,
    '',
    'Resumo publicado:',
    input.topic.summary || 'Nao existe resumo publicado.',
    '',
    'Memoria do agente:',
    input.topic.agentMemory?.overview || 'Nao existe memoria publicada.',
    '',
    'Fatos rapidos:',
    keyFacts || '- Nenhum fato rapido publicado.',
    '',
    'FAQ / aprendizado:',
    frequentQuestions || '- Nenhum FAQ publicado.',
    '',
    'Pontos principais para aprender:',
    learningTopics || '- Nenhum topico didatico publicado.',
    '',
    'Dicas rapidas:',
    quickTips || '- Nenhuma dica publicada.',
    '',
    'Trechos relevantes do material:',
    chunksBlock || 'Nenhum chunk encontrado para esta pergunta.',
    '',
    `Pergunta do usuario: ${input.question}`,
    '',
    'Formato da resposta:',
    '- Use exatamente estes blocos, nesta ordem:',
    'RESPOSTA DIRETA:',
    'O QUE ENTREGAR:',
    'PRAZO:',
    'ATENCAO:',
    'PROXIMO PASSO:',
    '- Em cada bloco, seja curto e concreto.',
    '- Se um bloco nao tiver informacao confirmada, diga "Nao encontrei isso no material".',
    '- Nao use markdown, tabela, pipe, asterisco, titulo com #, bloco de citacao ou texto decorativo.',
    '- Use frases simples e bullets normais apenas quando precisar listar algo.',
    '- Nao invente dados.',
    '- Se as imagens anexadas ajudarem, use-as tambem.',
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
    '- Responda primeiro a pergunta real do usuario.',
    '- Se a pergunta for pratica, entregue orientacao executavel.',
    '- Nao devolva so "nao encontrei" sem orientar o que fazer agora.',
    '- Mantenha os mesmos blocos obrigatorios.',
    '',
    'Resposta anterior ruim:',
    input.previousAnswer,
  ].join('\n')
}

function buildSuggestedQuestions(topic: PublicTopic) {
  return [
    `O que preciso entregar em ${topic.title}?`,
    'Me faca um checklist do que preciso fazer agora.',
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
    deadline: [],
    attention: [],
    nextSteps: [],
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
    }
  }

  return parsed
}

function normalizeStructuredAnswer(answer: string) {
  const parsed = parseStructuredAnswer(answer)
  return [
    `RESPOSTA DIRETA: ${parsed.direct || 'Nao encontrei isso no material'}`,
    `O QUE ENTREGAR: ${formatSectionItems(parsed.deliverables)}`,
    `PRAZO: ${formatSectionItems(parsed.deadline)}`,
    `ATENCAO: ${formatSectionItems(parsed.attention)}`,
    `PROXIMO PASSO: ${formatSectionItems(parsed.nextSteps)}`,
  ].join('\n')
}

function normalizeSection(value: string): keyof ParsedStructuredAnswer | null {
  const normalized = normalize(value)
  if (/^resposta direta|^resumo/.test(normalized)) return 'direct'
  if (/^o que entregar|^entrega|^entreg/.test(normalized)) return 'deliverables'
  if (/^prazo|^data/.test(normalized)) return 'deadline'
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
    .replace(/\s+/g, ' ')
    .trim()
}

function formatSectionItems(items: string[]) {
  const visible = items.map((item) => sanitizeAnswerText(item)).filter(Boolean)
  if (visible.length === 0) {
    return 'Nao encontrei isso no material'
  }

  return visible.slice(0, 3).map((item) => `- ${item}`).join(' ')
}

function evaluateAnswerQuality(question: string, parsed: ParsedStructuredAnswer) {
  const normalizedQuestion = normalize(question)
  const combined = normalize([parsed.direct, ...parsed.deliverables, ...parsed.deadline, ...parsed.attention, ...parsed.nextSteps].join(' '))
  const missingSections: string[] = []

  if (!parsed.direct || parsed.direct.length < 24 || /^nao encontrei isso no material$/i.test(parsed.direct)) {
    missingSections.push('RESPOSTA DIRETA')
  }

  if (/\bpython\b|\bcodigo\b|\bscript\b/.test(normalizedQuestion)) {
    if (!/\bpython\b|\bcodigo\b|\bscript\b/.test(combined)) {
      missingSections.push('RESPOSTA DIRETA')
    }
    if (!parsed.nextSteps.some((item) => /\b(abra|prepare|confirme|foco|ignore|use|revise|valide)\b/i.test(item))) {
      missingSections.push('PROXIMO PASSO')
    }
  }

  if (/\b(prazo|deadline|data|vence)\b/.test(normalizedQuestion) && parsed.deadline.length === 0) {
    missingSections.push('PRAZO')
  }

  if (/\b(entregar|entrega|arquivo|anexo)\b/.test(normalizedQuestion) && parsed.deliverables.length === 0) {
    missingSections.push('O QUE ENTREGAR')
  }

  if (/\b(checklist|dica|como|nao entendi|ajuda)\b/.test(normalizedQuestion) && parsed.nextSteps.length === 0) {
    missingSections.push('PROXIMO PASSO')
  }

  return {
    accepted: missingSections.length === 0,
    reason: missingSections.length === 0 ? 'Resposta validada pela IA.' : `Resposta fraca; faltou ${missingSections.join(', ')}.`,
    missingSections: Array.from(new Set(missingSections)),
  }
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

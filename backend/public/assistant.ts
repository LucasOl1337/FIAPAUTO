import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { runtimePaths } from '../config/runtimePaths.ts'
import type { LlmDocument, LlmImage } from '../connections/llm/llmClient.ts'
import { appendLlmDebugEvent } from '../connections/llm/llmDebugStore.ts'
import { routeAssistantChat } from '../connections/llm/providerRouter.ts'
import { classifyQuestionIntent, type QuestionIntent } from '../engine/questionIntentClassifier.ts'
import type { PublicChatResponse, PublicTopic, PublishedKnowledgeChunk } from '@fiapauto/contracts'
import { readJsonFile, writeJsonFile } from '../database/fs.ts'
import { appendPublicChatTraceEvent, buildPublicTraceEvent } from './monitorStore.ts'

type Citation = PublicChatResponse['citations'][number]

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

type ToolUsageContext = {
  toolLabel: string
  toolKey: string
  hasMentionInContext: boolean
  hasExplicitRequirement: boolean
}

type PublicExactAnswerCacheEntry = {
  id: string
  topicId: string
  question: string
  questionNormalized: string
  answer: string
  sections: PublicChatResponse['sections']
  confidence: PublicChatResponse['confidence']
  strategyUsed: 'rag_llm'
  providerUsed: 'qwen' | 'ollama'
  fallbackLevel: number
  citations: PublicChatResponse['citations']
  suggestedQuestions: string[]
  nextSteps: string[]
  answeredAt: string
  qualityStatus: 'accepted' | 'regenerated'
  qualityReason: string
  answeredByPass: 'primary' | 'retry'
  missingSections?: string[]
  model: string
  contentSignature: string
  createdAt: string
}

const PUBLIC_QWEN_MODEL = process.env.PUBLIC_LLM_MODEL ?? process.env.LLM_MODEL ?? process.env.LLM_MODEL_NAME ?? 'qwen3.5:397b-cloud'
const PUBLIC_EXACT_CACHE_FILE = path.join(runtimePaths.knowledgeCatalogDir, 'public-exact-answers.json')

export type PublicTraceContext = {
  requestId: string
  clientIp?: string
  userAgent?: string
}

export async function answerPublishedTopicQuestion(input: {
  topic: PublicTopic
  chunks: PublishedKnowledgeChunk[]
  question: string
  traceContext?: PublicTraceContext
}) {
  const intent = classifyQuestionIntent(input.question)
  const scopedChunks = input.chunks.filter((chunk) => chunk.topicId === input.topic.id)
  const rankedChunks = rankChunks(scopedChunks, input.question, intent)
  const citations = rankedChunks.slice(0, 3).map((chunk) => ({
    sourceType: chunk.sourceType === 'overview' ? 'summary' : chunk.sourceType,
    sourceLabel: `${input.topic.title} / ${chunk.sourceType}`,
    snippet: chunk.text,
  })) satisfies Citation[]
  const confidence = citations.length >= 2 ? 'high' : citations.length === 1 ? 'medium' : 'low'
  const prompt = buildPrompt({
    topic: input.topic,
    question: input.question,
    rankedChunks: rankedChunks.slice(0, 6),
    intent,
  })
  const documents = buildDocuments(input.topic, citations, intent)
  const images = shouldAttachTopicImages(input.question) ? await readTopicImages(input.topic) : []
  const traceContext = input.traceContext
  const startedAt = Date.now()
  const lastLlmPrompt = prompt
  let lastLlmOutput = ''

  try {
    await appendTraceDebugEvent({
      traceContext,
      topicId: input.topic.id,
      messageKind: 'user_prompt',
      request: input.question,
      response: '',
    })

    const exactCache = await findExactPublicAnswerCacheMatch({
      topic: input.topic,
      chunks: scopedChunks,
      question: input.question,
    })
    if (exactCache) {
      const cachedPayload = toPublicChatResponseFromCache(exactCache)
      await appendAssistantTraceEvent({
        traceContext,
        topicId: input.topic.id,
        question: input.question,
        durationMs: Date.now() - startedAt,
        payload: cachedPayload,
        model: exactCache.model,
      })
      return cachedPayload
    }

    await appendTraceDebugEvent({
      traceContext,
      topicId: input.topic.id,
      messageKind: 'llm_prompt',
      request: prompt,
      response: '',
    })
    if (traceContext?.requestId) {
      await appendPublicChatTraceEvent(
        buildPublicTraceEvent({
          requestId: traceContext.requestId,
          phase: 'started',
          clientIp: traceContext.clientIp,
          userAgent: traceContext.userAgent,
          topicId: input.topic.id,
          question: input.question,
          llmPrompt: prompt,
          model: PUBLIC_QWEN_MODEL,
        }),
      )
    }
    const primary = await requestPublicQwenChat({
      jobId: `public-topic-ask-${input.topic.id}-${Date.now()}`,
      topicId: input.topic.id,
      prompt,
      documents,
      images,
      traceContext,
    })
    lastLlmOutput = primary.answer

    if (!primary.answer.trim()) {
      throw new Error('public_llm_empty_primary_response')
    }

    const primaryPayload = buildProviderPayload({
      input,
      citations,
      confidence,
      intent,
      providerResponse: primary,
      answer: primary.answer,
      qualityStatus: 'accepted',
      answeredByPass: 'primary',
    })

    if (primaryPayload.qualityAccepted) {
      await saveExactPublicAnswerCacheEntry({
        topic: input.topic,
        chunks: scopedChunks,
        question: input.question,
        payload: primaryPayload,
      })
    }
    await appendAssistantTraceEvent({
      traceContext,
      topicId: input.topic.id,
      question: input.question,
      llmPrompt: lastLlmPrompt,
      llmOutput: lastLlmOutput,
      durationMs: Date.now() - startedAt,
      payload: primaryPayload,
    })
    return primaryPayload
  } catch (error) {
    await appendTraceDebugEvent({
      traceContext,
      topicId: input.topic.id,
      messageKind: 'error',
      request: lastLlmPrompt,
      response: lastLlmOutput,
      error: error instanceof Error ? error.message : 'public_qwen_failed',
    })
    await appendPublicChatTraceEvent(
      buildPublicTraceEvent({
        requestId: traceContext?.requestId ?? randomUUID(),
        clientIp: traceContext?.clientIp,
        userAgent: traceContext?.userAgent,
        topicId: input.topic.id,
        question: input.question,
        llmPrompt: lastLlmPrompt,
        llmOutput: lastLlmOutput,
        providerUsed: 'qwen',
        strategyUsed: 'rag_llm',
        qualityStatus: 'fallback',
        answeredByPass: 'retry',
        model: PUBLIC_QWEN_MODEL,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : 'public_qwen_failed',
      }),
    )
    throw new Error(error instanceof Error ? error.message : 'public_qwen_failed')
  }
}

function buildProviderPayload(input: {
  input: { topic: PublicTopic; question: string }
  citations: Citation[]
  confidence: PublicChatResponse['confidence']
  intent: QuestionIntent
  providerResponse: {
    answer: string
    providerUsed: NonNullable<PublicChatResponse['providerUsed']>
    strategyUsed: PublicChatResponse['strategyUsed']
    fallbackLevel: number
  }
  answer: string
  qualityStatus: 'accepted' | 'regenerated'
  answeredByPass: 'primary' | 'retry'
}): PublicChatResponse & { qualityAccepted: boolean } {
  const parsed = parseStructuredAnswer(input.answer)
  const evaluation = evaluateAnswerQuality({
    question: input.input.question,
    topic: input.input.topic,
    intent: input.intent,
    parsed,
    citations: input.citations,
  })

  if (!evaluation.accepted) {
    const nextSteps = buildActionableSteps({
      topic: input.input.topic,
      question: input.input.question,
      intent: input.intent,
      citations: input.citations,
    })
    return {
      topicId: input.input.topic.id,
      answer: input.answer,
      sections: buildResponseSections({
        summary10s: parsed.direct,
        fullAnswer: [sanitizeAnswerText(input.answer)],
        deliverables: parsed.deliverables,
        attentionPoints: parsed.attention,
        nextSteps,
        followUpQuestions: buildSuggestedQuestions(input.intent),
      }),
      confidence: input.confidence,
      strategyUsed: input.providerResponse.strategyUsed,
      providerUsed: input.providerResponse.providerUsed,
      fallbackLevel: input.providerResponse.fallbackLevel,
      citations: input.citations,
      suggestedQuestions: buildSuggestedQuestions(input.intent),
      nextSteps,
      answeredAt: new Date().toISOString(),
      qualityStatus: input.qualityStatus,
      qualityReason: evaluation.reason,
      answeredByPass: input.answeredByPass,
      missingSections: evaluation.missingSections,
      qualityAccepted: false,
    } satisfies PublicChatResponse & { qualityAccepted: boolean }
  }

  const nextSteps = parsed.nextSteps.length > 0
    ? parsed.nextSteps.slice(0, 3)
    : buildActionableSteps({
      topic: input.input.topic,
      question: input.input.question,
      intent: input.intent,
      citations: input.citations,
    })
  const formattedAnswer = formatStructuredAnswer({
    direct: parsed.direct,
    deliverables: parsed.deliverables,
    attention: parsed.attention,
    nextSteps: parsed.nextSteps,
  })
  return {
    topicId: input.input.topic.id,
    answer: formattedAnswer,
    sections: buildResponseSections({
      summary10s: parsed.direct,
      fullAnswer: [sanitizeAnswerText(parsed.direct)],
      deliverables: parsed.deliverables,
      attentionPoints: parsed.attention,
      nextSteps,
      followUpQuestions: buildSuggestedQuestions(input.intent),
    }),
    confidence: input.confidence,
    strategyUsed: input.providerResponse.strategyUsed,
    providerUsed: input.providerResponse.providerUsed,
    fallbackLevel: input.providerResponse.fallbackLevel,
    citations: input.citations,
    suggestedQuestions: buildSuggestedQuestions(input.intent),
    nextSteps,
    answeredAt: new Date().toISOString(),
    qualityStatus: input.qualityStatus,
    qualityReason: evaluation.reason,
    answeredByPass: input.answeredByPass,
    missingSections: evaluation.missingSections,
    qualityAccepted: true,
  } satisfies PublicChatResponse & { qualityAccepted: boolean }
}

async function findExactPublicAnswerCacheMatch(input: {
  topic: PublicTopic
  chunks: PublishedKnowledgeChunk[]
  question: string
}) {
  const entries = await readJsonFile<PublicExactAnswerCacheEntry[]>(PUBLIC_EXACT_CACHE_FILE, [])
  const questionNormalized = normalizeQuestionForCache(input.question)
  const contentSignature = buildPublicContentSignature(input.topic, input.chunks)
  return entries.find((entry) =>
    entry.topicId === input.topic.id
    && entry.questionNormalized === questionNormalized
    && entry.contentSignature === contentSignature
    && ['qwen', 'ollama'].includes(entry.providerUsed)
    && ['accepted', 'regenerated'].includes(entry.qualityStatus)
  ) ?? null
}

async function saveExactPublicAnswerCacheEntry(input: {
  topic: PublicTopic
  chunks: PublishedKnowledgeChunk[]
  question: string
  payload: PublicChatResponse & { qualityAccepted?: boolean }
}) {
  if (!['qwen', 'ollama'].includes(input.payload.providerUsed)) {
    return
  }

  if (!['accepted', 'regenerated'].includes(input.payload.qualityStatus)) {
    return
  }

  const qualityStatus = input.payload.qualityStatus === 'accepted' ? 'accepted' : 'regenerated'
  const questionNormalized = normalizeQuestionForCache(input.question)
  const contentSignature = buildPublicContentSignature(input.topic, input.chunks)
  const currentEntries = await readJsonFile<PublicExactAnswerCacheEntry[]>(PUBLIC_EXACT_CACHE_FILE, [])
  const nextEntry = {
    id: randomUUID(),
    topicId: input.topic.id,
    question: input.question,
    questionNormalized,
    answer: input.payload.answer,
    sections: input.payload.sections,
    confidence: input.payload.confidence,
    strategyUsed: 'rag_llm',
    providerUsed: input.payload.providerUsed === 'ollama' ? 'ollama' : 'qwen',
    fallbackLevel: input.payload.fallbackLevel ?? 0,
    citations: input.payload.citations,
    suggestedQuestions: input.payload.suggestedQuestions,
    nextSteps: input.payload.nextSteps,
    answeredAt: input.payload.answeredAt,
    qualityStatus,
    qualityReason: input.payload.qualityReason,
    answeredByPass: input.payload.answeredByPass === 'retry' ? 'retry' : 'primary',
    missingSections: input.payload.missingSections,
    model: PUBLIC_QWEN_MODEL,
    contentSignature,
    createdAt: new Date().toISOString(),
  } satisfies PublicExactAnswerCacheEntry
  const deduped = [
    nextEntry,
    ...currentEntries.filter((entry) => !(
      entry.topicId === nextEntry.topicId
      && entry.questionNormalized === nextEntry.questionNormalized
      && entry.contentSignature === nextEntry.contentSignature
    )),
  ].slice(0, 500)
  await writeJsonFile(PUBLIC_EXACT_CACHE_FILE, deduped)
}

function toPublicChatResponseFromCache(entry: PublicExactAnswerCacheEntry): PublicChatResponse {
  return {
    topicId: entry.topicId,
    answer: entry.answer,
    sections: entry.sections,
    confidence: entry.confidence,
    strategyUsed: entry.strategyUsed,
    providerUsed: entry.providerUsed,
    fallbackLevel: entry.fallbackLevel,
    citations: entry.citations,
    suggestedQuestions: entry.suggestedQuestions,
    nextSteps: entry.nextSteps,
    answeredAt: new Date().toISOString(),
    qualityStatus: entry.qualityStatus,
    qualityReason: `${entry.qualityReason} Resposta identica reaproveitada do cache validado do LLM.`,
    answeredByPass: 'cache',
    missingSections: entry.missingSections,
  }
}

function normalizeQuestionForCache(value: string) {
  return normalizeText(value)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildPublicContentSignature(topic: PublicTopic, chunks: PublishedKnowledgeChunk[]) {
  const hash = createHash('sha1')
  hash.update(topic.id)
  hash.update('|')
  hash.update(topic.updatedAt ?? '')
  hash.update('|')
  for (const chunk of chunks
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update(chunk.id)
    hash.update('|')
    hash.update(chunk.capturedAt)
    hash.update('|')
    hash.update(chunk.text)
    hash.update('\n')
  }
  return hash.digest('hex')
}

async function requestPublicQwenChat(input: {
  jobId: string
  topicId: string
  prompt: string
  documents: LlmDocument[]
  images: LlmImage[]
  traceContext?: PublicTraceContext
}) {
  const response = await routeAssistantChat({
    jobId: input.jobId,
    topicId: input.topicId,
    prompt: input.prompt,
    documents: input.documents,
    images: input.images,
  }, {
    allowedProviders: ['ollama'],
  })

  await appendTraceDebugEvent({
    traceContext: input.traceContext,
    topicId: input.topicId,
    messageKind: 'llm_response',
    request: input.prompt,
    response: response.answer.trim(),
    provider: response.providerUsed,
  })

  return {
    answer: response.answer.trim(),
    providerUsed: response.providerUsed,
    strategyUsed: response.strategyUsed,
    fallbackLevel: response.fallbackLevel,
  }
}

async function appendTraceDebugEvent(input: {
  traceContext?: PublicTraceContext
  topicId: string
  messageKind: 'user_prompt' | 'llm_prompt' | 'llm_response' | 'error'
  request: unknown
  response: unknown
  error?: string
  provider?: 'qwen' | 'gemini' | 'ollama' | 'local'
}) {
  if (!input.traceContext?.requestId) {
    return
  }

  await appendLlmDebugEvent({
    id: randomUUID(),
    ts: new Date().toISOString(),
    endpoint: '/api/chat',
    jobId: `public-trace-${input.traceContext.requestId}`,
    topicId: input.topicId,
    requestId: input.traceContext.requestId,
    clientIp: input.traceContext.clientIp,
    provider: input.provider ?? (input.messageKind === 'error' ? 'local' : 'qwen'),
    model: PUBLIC_QWEN_MODEL,
    messageKind: input.messageKind,
    statusCode: input.error ? 500 : 200,
    durationMs: 0,
    request: input.request,
    response: input.response,
    error: input.error,
  })
}

async function appendAssistantTraceEvent(input: {
  traceContext?: PublicTraceContext
  topicId: string
  question: string
  llmPrompt?: string
  llmOutput?: string
  durationMs?: number
  payload: PublicChatResponse
  error?: string
  model?: string
}) {
  if (!input.traceContext?.requestId) {
    return
  }

  await appendPublicChatTraceEvent(
    buildPublicTraceEvent({
      requestId: input.traceContext.requestId,
      clientIp: input.traceContext.clientIp,
      userAgent: input.traceContext.userAgent,
      topicId: input.topicId,
      question: input.question,
      llmPrompt: input.llmPrompt,
      llmOutput: input.llmOutput,
      finalAnswer: input.payload.answer,
      providerUsed: input.payload.providerUsed,
      strategyUsed: input.payload.strategyUsed,
      qualityStatus: input.payload.qualityStatus,
      answeredByPass: input.payload.answeredByPass,
      model: input.model ?? PUBLIC_QWEN_MODEL,
      durationMs: input.durationMs,
      error: input.error,
    }),
  )
}

function buildResponseSections(input: {
  summary10s: string
  fullAnswer: string[]
  deliverables: string[]
  attentionPoints: string[]
  nextSteps: string[]
  followUpQuestions: string[]
}): PublicChatResponse['sections'] {
  const deliverables = cleanDeliverableItems(input.deliverables).slice(0, 3)
  const attentionPoints = cleanAttentionItems(input.attentionPoints).slice(0, 3)
  const nextSteps = cleanNextStepItems(input.nextSteps).slice(0, 3)
  const summary10s = buildSafeSummary(input.summary10s, deliverables, nextSteps)
  const fullAnswer = cleanFullAnswerItems(input.fullAnswer).slice(0, 4)
  return {
    summary10s,
    fullAnswer: fullAnswer.length > 0 ? fullAnswer : [summary10s],
    deliverables,
    attentionPoints,
    nextSteps,
    followUpQuestions: dedupeItems(input.followUpQuestions).slice(0, 3),
    answerMode:
      deliverables.length > 0 && nextSteps.length > 0
        ? 'grounded'
        : nextSteps.length > 0 || attentionPoints.length > 0
          ? 'mixed'
          : 'general_guidance',
  }
}

function buildPrompt(input: {
  topic: PublicTopic
  question: string
  rankedChunks: PublishedKnowledgeChunk[]
  intent: QuestionIntent
}) {
  const promptChunks = selectPromptChunks(input.rankedChunks, input.intent)
  const promptCitations = promptChunksToCitations(input.topic, promptChunks)
  const deliverables = buildDeliverableItems(input.topic, promptCitations)
  const attention = buildAttentionItems(input.topic, promptCitations)
  const nextSteps = buildActionableSteps({
    topic: input.topic,
    question: input.question,
    intent: input.intent,
    citations: promptCitations,
  })
  const chunkBlock = promptChunks
    .map((chunk, index) => `Trecho ${index + 1} (${chunk.sourceType}): ${cleanProviderSnippet(chunk.text)}`)
    .join('\n')
  const contextDescription = buildPromptContextDescription(input.topic, promptCitations)

  return [
    'Voce e o assistente academico do FiapFlow.',
    'Responda sempre em portugues do Brasil.',
    'Seu objetivo principal e maximizar o aprendizado do aluno com clareza, utilidade e honestidade.',
    '',
    'Antes de responder, faca internamente esta analise:',
    '1. Entenda o contexto da materia atual.',
    '2. Identifique o que o aluno realmente quer saber, mesmo que a pergunta esteja mal formulada.',
    '3. Compare a pergunta com a materia e classifique a relacao entre elas como: diretamente relacionada, parcialmente relacionada, vagamente relacionada ou nao relacionada.',
    '4. Avalie se ha contexto suficiente para responder com seguranca.',
    '5. Escolha a resposta que mais ajuda o aluno a aprender, sem inventar conteudo e sem fingir certeza.',
    '',
    'Regras de comportamento:',
    '- Nunca invente informacoes, entregas, datas, criterios ou conteudo academico.',
    '- Nunca finja que entendeu algo que nao esta claro.',
    '- Se a pergunta estiver boa e alinhada com a materia, responda normalmente da melhor forma possivel.',
    '- Se a pergunta estiver incompleta, ambigua ou vaga, diga isso de forma curta e ajude o aluno a reformular.',
    '- Se a pergunta estiver parcialmente relacionada, aproveite a parte valida e redirecione o restante.',
    '- Se a pergunta nao estiver relacionada a materia, deixe isso claro e sugira como adapta-la ao contexto correto.',
    '- Se a pergunta nao estiver relacionada a materia, nao transforme automaticamente a resposta em checklist, entrega, resumo ou explicacao do trabalho.',
    '- Use o contexto da materia apenas quando ele realmente ajudar a responder a pergunta do aluno.',
    '- Nunca force entregaveis, atencoes ou proximos passos da materia quando o tema perguntado estiver fora do contexto.',
    '- Sempre priorize utilidade pratica para o aluno.',
    '- Sempre que possivel, transforme a duvida em algo mais claro, acionavel e facil de estudar.',
    '',
    'Estrategia de resposta:',
    '- Se houver resposta confiavel: explique de forma simples, objetiva e util.',
    '- Se houver risco de ma interpretacao: destaque rapidamente o ponto de atencao.',
    '- Se faltar contexto: peca reformulacao curta e de exemplos concretos.',
    '- Se a pergunta envolver atividade, trabalho ou entrega: explique exatamente o que parece ser pedido, mas apenas se isso estiver sustentado pelo contexto.',
    '- Se a pergunta permitir, inclua exemplos ligados a materia atual.',
    '',
    'Criterio de qualidade da resposta:',
    '- Clareza > floreio',
    '- Utilidade pratica > formalidade',
    '- Honestidade > completar lacunas no chute',
    '- Aprendizado real > resposta generica',
    '',
    'Formato da resposta:',
    '- Nao use um formato rigido sempre.',
    '- Adapte o formato ao caso para gerar a melhor resposta possivel.',
    '- Quando necessario, voce pode usar blocos como:',
    '  - Resposta direta',
    '  - O que entregar',
    '  - Atencao',
    '  - Proximo passo',
    '- Mas so use esses blocos se eles realmente melhorarem a resposta.',
    '',
    `Materia atual: ${input.topic.title}`,
    `Descricao da materia / contexto disponivel: ${contextDescription || 'nao informado'}`,
    `Pergunta do aluno: ${input.question}`,
    '',
    `Sinais de contexto detectados: entregaveis=${deliverables.join(' | ') || 'nao identificados'} ; atencao=${attention.join(' | ') || 'nao identificada'} ; proximos_passos=${nextSteps.join(' | ') || 'nao identificado'}`,
    '',
    `Trechos relevantes do material:\n${chunkBlock || 'Nenhum trecho relevante encontrado.'}`,
    '',
    'Sua tarefa final:',
    'Entregar a melhor resposta possivel para ajudar o aluno a aprender com base na relacao entre a materia e a pergunta.',
    'Se a pergunta estiver fraca, alem de responder o que for possivel, melhore a direcao da duvida.',
    'Se a pergunta estiver desalinhada, redirecione com inteligencia.',
    'Se a pergunta estiver boa, responda de forma excelente.',
    '',
    'Nunca escreva analise interna. Apenas a resposta final para o aluno.',
  ].join('\n')
}

function buildPromptContextDescription(topic: PublicTopic, citations: Citation[]) {
  return dedupeItems([
    buildContextOverview(topic, citations),
    topic.summary,
    topic.agentMemory?.overview,
  ]).find(Boolean) ?? ''
}

function selectPromptChunks(chunks: PublishedKnowledgeChunk[], intent: QuestionIntent) {
  const limit = getPromptChunkLimit(intent)
  const preferredSourceTypes = getPreferredPromptSourceTypes(intent)
  const prioritized = chunks.filter((chunk) => preferredSourceTypes.includes(chunk.sourceType))
  const fallback = chunks.filter((chunk) => !preferredSourceTypes.includes(chunk.sourceType))
  return [...prioritized, ...fallback].slice(0, limit)
}

function getPromptChunkLimit(intent: QuestionIntent) {
  if (intent === 'deliverable' || intent === 'grading' || intent === 'format' || intent === 'tool_usage') {
    return 3
  }

  return 2
}

function getPreferredPromptSourceTypes(intent: QuestionIntent) {
  switch (intent) {
    case 'deliverable':
      return ['deliverable', 'content', 'faq']
    case 'grading':
    case 'format':
      return ['content', 'deliverable', 'faq']
    case 'tool_usage':
    case 'off_topic_learning':
      return ['overview', 'summary', 'faq']
    case 'explanation':
    case 'summary':
      return ['summary', 'overview', 'faq']
    case 'next_steps':
    case 'unknown':
    case 'greeting':
      return ['overview', 'deliverable', 'summary']
    default:
      return ['summary', 'overview', 'deliverable']
  }
}

function promptChunksToCitations(topic: PublicTopic, chunks: PublishedKnowledgeChunk[]) {
  return chunks.map((chunk) => ({
    sourceType: chunk.sourceType === 'overview' ? 'summary' : chunk.sourceType,
    sourceLabel: `${topic.title} / ${chunk.sourceType}`,
    snippet: chunk.text,
  })) satisfies Citation[]
}

function buildDocuments(topic: PublicTopic, citations: Citation[], intent?: QuestionIntent) {
  if (intent === 'smalltalk_or_noise') {
    return [
      {
        name: `${topic.id}.summary.txt`,
        content: buildContextOverview(topic, citations),
      },
    ].filter((item) => item.content.trim())
  }

  const normalizedLearning = normalizeLearning(topic.learning)
  const deliverables = buildDeliverableItems(topic, citations)
  const attention = buildAttentionItems(topic, citations)
  const documents = [
    {
      name: `${topic.id}.summary.txt`,
      content: buildContextOverview(topic, citations),
    },
    {
      name: `${topic.id}.memory.txt`,
      content: JSON.stringify({
        overview: buildContextOverview(topic, citations),
        deliverables,
        attention,
        keyFacts: cleanAttentionItems(topic.agentMemory?.keyFacts ?? []).slice(0, 5),
      }),
    },
    {
      name: `${topic.id}.learning.txt`,
      content: JSON.stringify({
        frequentQuestions: normalizedLearning?.frequentQuestions ?? [],
        learningTopics: normalizedLearning?.learningTopics ?? [],
        quickTips: normalizedLearning?.quickTips ?? [],
      }),
    },
    {
      name: `${topic.id}.citations.txt`,
      content: citations.map((item) => `${item.sourceType}: ${cleanProviderSnippet(item.snippet)}`).join('\n'),
    },
  ].filter((item) => item.content.trim())

  if (intent === 'deliverable' || intent === 'grading' || intent === 'format') {
    return documents.filter((item) => item.name.endsWith('.summary.txt') || item.name.endsWith('.citations.txt'))
  }

  if (intent === 'tool_usage' || intent === 'off_topic_learning' || intent === 'next_steps' || intent === 'unknown' || intent === 'greeting') {
    return documents.filter((item) => item.name.endsWith('.summary.txt') || item.name.endsWith('.memory.txt'))
  }

  if (intent === 'explanation' || intent === 'summary') {
    return documents.filter((item) => !item.name.endsWith('.citations.txt') || citations.length > 0).slice(0, 3)
  }

  return documents.slice(0, 3)
}

async function readTopicImages(topic: PublicTopic) {
  const imageKeys = topic.screenshots.slice(0, 2)
  const images = await Promise.all(
    imageKeys.map(async (key, index) => {
      try {
        const resolved = path.resolve(runtimePaths.publicCurrentDir, ...key.replace(/^\/+/, '').split('/'))
        const root = path.resolve(runtimePaths.publicCurrentDir)
        if (!resolved.startsWith(root)) {
          return null
        }

        const buffer = await fs.readFile(resolved)
        return {
          name: `${topic.id}-image-${index + 1}.png`,
          mime: 'image/png',
          data: buffer.toString('base64'),
        }
      } catch {
        return null
      }
    }),
  )

  return images.filter((item): item is NonNullable<typeof item> => Boolean(item))
}

function buildDeliverableItems(topic: PublicTopic, citations: Citation[]) {
  const summaryItems = extractDeliverableSignals(topic.summary || '')
  const memoryItems = (topic.agentMemory?.deliverables ?? []).flatMap((item) => extractDeliverableSignals(item))
  const attachmentItems = topic.attachments.map((item) => normalizeDeliverableSignal(item.name))
  const citationItems = citations
    .filter((item) => item.sourceType === 'deliverable' || /pdf|excel|xlsx|apresenta|formulario|planilha|oral|pesquisa|questionario/i.test(item.snippet))
    .flatMap((item) => extractDeliverableSignals(item.snippet))

  const values = cleanDeliverableItems([
    ...memoryItems,
    ...summaryItems,
    ...citationItems,
    ...attachmentItems,
  ])

  if (values.length > 0) {
    return values.slice(0, 3)
  }

  return []
}

function buildActionableSteps(input: {
  topic: PublicTopic
  question: string
  intent: QuestionIntent
  citations: Citation[]
}) {
  const steps: string[] = []
  const normalizedQuestion = normalizeText(input.question)
  const toolContext = getToolUsageContext({
    topic: input.topic,
    citations: input.citations,
    question: input.question,
  })

  if (/\bpython\b|\br\b|\bcodigo\b|\bscript\b/.test(normalizedQuestion)) {
    if (!toolContext.hasExplicitRequirement) {
      steps.push(`Nao trate ${toolContext.toolLabel} como exigencia agora: primeiro confirme o que realmente foi pedido no trabalho.`)
      steps.push('Se este checkpoint for o correto, foque nos entregaveis publicados e valide o PDF principal.')
    }
  }

  if (input.intent === 'smalltalk_or_noise') {
    return [
      'Pergunte algo direto, como "o que preciso entregar?" ou "me faca um checklist".',
      `Se quiser, eu posso resumir ${input.topic.title} em linguagem simples.`,
    ]
  }

  if (input.intent === 'off_topic_learning') {
    steps.push('Aprenda o conceito em duas ou tres ideias simples e depois aplique isso ao entregavel atual.')
  }

  if (input.intent === 'deliverable') {
    steps.push('Monte uma checklist curta dos arquivos que precisam ser enviados antes de produzir a versao final.')
  }

  if (input.intent === 'tool_usage') {
    if (/\bpython\b|\br\b|\bcodigo\b|\bscript\b/.test(normalizedQuestion)) {
      steps.push(`Se quiser usar ${toolContext.toolLabel}, use apenas para apoiar a organizacao, limpeza ou analise dos dados antes de montar o arquivo final.`)
      steps.push('Nao comece codando no escuro: confirme primeiro o entregavel oficial e depois exporte o resultado final no formato pedido.')
    }
  }

  if (input.intent === 'next_steps' || input.intent === 'explanation' || input.intent === 'unknown') {
    steps.push(`Transforme ${input.topic.title} em 2 ou 3 tarefas praticas antes de executar.`)
  }

  steps.push('Abra o anexo principal para validar detalhes finos antes de executar.')

  const deliverables = buildDeliverableItems(input.topic, input.citations)
  if (deliverables.length > 0) {
    steps.push(`Prepare primeiro os entregaveis principais: ${deliverables.slice(0, 2).join(' e ')}.`)
  } else {
    steps.push('Monte uma checklist curta com entregaveis, formato e validacoes finais.')
  }

  return cleanNextStepItems(steps).slice(0, 3)
}

function buildAttentionItems(topic: PublicTopic, citations: Citation[]) {
  const sourceText = normalizeText([
    ...(topic.agentMemory?.keyFacts ?? []),
    ...citations.map((item) => item.snippet),
    topic.summary,
  ].filter(Boolean).join(' '))
  const items: string[] = []

  if (/\b100\b.*respondent|dados fictic/.test(sourceText)) {
    items.push('Use respondentes reais e nao inclua dados ficticios.')
  }
  if (/ausencia.*oral|nota zero|particip/.test(sourceText)) {
    items.push('Garanta a participacao oral de quem for avaliado.')
  }
  if (/abnt|sem links|formatos? sem links/.test(sourceText)) {
    items.push('Siga ABNT e nao deixe links nos arquivos finais.')
  }
  if (/nome completo|matricul/.test(sourceText)) {
    items.push('Inclua nome completo e matricula em cada arquivo.')
  }
  if (/maximo 6 por grupo/.test(sourceText)) {
    items.push('Mantenha o grupo dentro do limite de integrantes.')
  }

  if (items.length > 0) {
    return cleanAttentionItems(items).slice(0, 3)
  }

  return cleanAttentionItems(['Confirme no PDF principal os criterios finais antes de enviar.']).slice(0, 1)
}

function evaluateAnswerQuality(input: {
  question: string
  topic: PublicTopic
  intent: QuestionIntent
  parsed: ParsedStructuredAnswer
  citations: Citation[]
}): QualityEvaluation {
  const missingSections: string[] = []
  const combinedDirect = normalizeText(input.parsed.direct)
  const combinedAll = normalizeText(
    [input.parsed.direct, ...input.parsed.deliverables, ...input.parsed.attention, ...input.parsed.nextSteps].join(' '),
  )
  const hasRelevantContext = Boolean(input.topic.summary || input.topic.agentMemory?.overview || input.citations.length > 0)
  const directLooksGeneric =
    !input.parsed.direct
    || combinedDirect.length < 24
    || /^oi\b|^ola\b|^teste\b/.test(combinedDirect)
    || /^posso te ajudar/.test(combinedDirect)
    || /^nao encontrei isso no material$/.test(combinedDirect)
    || /^nao encontrei no material/.test(combinedDirect) && hasRelevantContext && input.parsed.nextSteps.length === 0
    || looksLikeRawMetadata(input.parsed.direct)

  if (directLooksGeneric) {
    missingSections.push('RESPOSTA DIRETA')
  }

  switch (input.intent) {
    case 'deliverable':
      if (cleanDeliverableItems(input.parsed.deliverables).length === 0 && !/entrega|arquivo|pdf|excel|anexo/.test(combinedAll)) {
        missingSections.push('O QUE ENTREGAR')
      }
      break
    case 'grading':
    case 'format':
      if (cleanAttentionItems(input.parsed.attention).length === 0 && !/penalidade|erro|abnt|nota|formato|risco|zero/.test(combinedAll)) {
        missingSections.push('ATENCAO')
      }
      break
    case 'tool_usage':
    case 'next_steps':
    case 'explanation':
    case 'unknown':
    case 'off_topic_learning':
      if (!hasActionableStep(input.parsed.nextSteps) && !/\bfa(ca|ca|zer)|abra|prepare|confirme|ignore|foco|siga|valide|use\b/.test(combinedAll)) {
        missingSections.push('PROXIMO PASSO')
      }
      break
    case 'smalltalk_or_noise':
      if (!/\b(pergunte|reformule|exemplo|entregaveis|checklist|pontos de atencao)\b/.test(combinedAll)) {
        missingSections.push('RESPOSTA DIRETA')
      }
      break
    case 'summary':
      if (combinedDirect.length < 60) {
        missingSections.push('RESPOSTA DIRETA')
      }
      break
    case 'greeting':
      if (combinedDirect.length < 40 && input.parsed.nextSteps.length === 0) {
        missingSections.push('RESPOSTA DIRETA')
      }
      break
    default:
      break
  }

  if ([...input.parsed.deliverables, ...input.parsed.attention, ...input.parsed.nextSteps].some(looksLikeBadPublicOutput)) {
    if (!missingSections.includes('O QUE ENTREGAR')) {
      missingSections.push('O QUE ENTREGAR')
    }
    if (!missingSections.includes('ATENCAO')) {
      missingSections.push('ATENCAO')
    }
  }

  if (/\bpython\b|\bcodigo\b|\bscript\b/.test(normalizeText(input.question))) {
    const toolContext = getToolUsageContext({
      topic: input.topic,
      citations: input.citations,
      question: input.question,
    })
    const toolMentionPattern = new RegExp(`\\b${toolContext.toolKey}\\b`, 'i')
    const mentionsQuestion = toolMentionPattern.test(combinedDirect)
    const redirectsAction = hasActionableStep(input.parsed.nextSteps)
    const marksOptionality = new RegExp(`\\b(opcional|obrigatori|nao foi exigid|nao e obrigatori|nao aparece como exigenc|nao encontrei .*${toolContext.toolKey}|${toolContext.toolKey} .*opcional|${toolContext.toolKey} .*nao foi exigid|nao e necessar|nao precisa|nao .* agora)\\b`, 'i').test(combinedAll)
    const reframesCurrentPriority = /\b(foco|foca|prioriza|priorize|primeiro|antes|agora|atividade|checkpoint|trabalho|entrega|entregaveis|arquivos)\b/.test(combinedAll)
    const anchorsDeliverable = /\b(entrega|entregavel|pdf|excel|planilha|arquivo|teams|apresenta)\b/.test(combinedAll)
    const practicalRedirect = redirectsAction || /\b(confirme|finalize|valide|organize|retome|estude .* depois|depois da entrega|volte nisso depois)\b/.test(combinedAll)
    const inventsMandatoryUsage = !toolContext.hasExplicitRequirement && /\b(use|instale|roda|rode|aplique)\s+python\b/.test(combinedDirect) && !marksOptionality

    if (!mentionsQuestion || !practicalRedirect || !(marksOptionality || reframesCurrentPriority) || !anchorsDeliverable || inventsMandatoryUsage) {
      if (!missingSections.includes('RESPOSTA DIRETA')) {
        missingSections.push('RESPOSTA DIRETA')
      }
      if (!missingSections.includes('PROXIMO PASSO')) {
        missingSections.push('PROXIMO PASSO')
      }
    }
  }

  const blockingSections = getBlockingMissingSections(input.intent)
  const blockingMissingSections = dedupeItems(missingSections.filter((item) => blockingSections.has(item)))

  return {
    accepted: blockingMissingSections.length === 0,
    reason:
      blockingMissingSections.length === 0
        ? 'Resposta validada pela IA.'
        : `Resposta insuficiente para a intencao ${input.intent}; faltou autosuficiencia em ${blockingMissingSections.join(', ')}.`,
    missingSections,
  }
}

function getBlockingMissingSections(intent: QuestionIntent) {
  switch (intent) {
    case 'deliverable':
      return new Set(['RESPOSTA DIRETA', 'O QUE ENTREGAR'])
    case 'grading':
    case 'format':
      return new Set(['RESPOSTA DIRETA', 'ATENCAO'])
    case 'tool_usage':
    case 'next_steps':
    case 'explanation':
    case 'unknown':
    case 'off_topic_learning':
      return new Set(['RESPOSTA DIRETA', 'PROXIMO PASSO'])
    case 'smalltalk_or_noise':
    case 'summary':
    case 'greeting':
      return new Set(['RESPOSTA DIRETA'])
    default:
      return new Set(['RESPOSTA DIRETA'])
  }
}

function parseStructuredAnswer(answer: string | undefined): ParsedStructuredAnswer {
  const lines = (answer ?? '')
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
    const sectionMatch = line.match(/^([A-Za-z\s]+):\s*(.*)$/)
    if (sectionMatch) {
      const sectionKey = normalizeSectionKey(sectionMatch[1] ?? '')
      if (sectionKey) {
        currentSection = sectionKey
        const inlineValue = sectionMatch[2]?.trim()
        if (inlineValue) {
          pushStructuredValue(parsed, sectionKey, inlineValue)
        }
        continue
      }
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)$/)
    if (bulletMatch && currentSection) {
      pushStructuredValue(parsed, currentSection, bulletMatch[1] ?? '')
      continue
    }

    if (currentSection) {
      pushStructuredValue(parsed, currentSection, line)
      continue
    }

    const cleaned = sanitizeAnswerText(line)
    if (cleaned) {
      parsed.extra.push(cleaned)
    }
  }

  if (!parsed.direct) {
    parsed.direct = parsed.extra[0] || sanitizeAnswerText(answer ?? '')
  }

  if (parsed.deliverables.length === 0) {
    parsed.deliverables.push(...extractDeliverableSignals(answer ?? ''))
  }

  if (parsed.attention.length === 0) {
    parsed.attention.push(...extractAttentionSignals(answer ?? ''))
  }

  if (parsed.nextSteps.length === 0) {
    parsed.nextSteps.push(...extractNextStepSignals(answer ?? ''))
  }

  return parsed
}

function normalizeSectionKey(value: string): keyof ParsedStructuredAnswer | null {
  const normalized = normalizeText(value)

  if (/^resposta direta|^resumo em 10 segundos|^resumo rapido/.test(normalized)) return 'direct'
  if (/^o que entregar|^entrega|^entregaveis?/.test(normalized)) return 'deliverables'
  if (/^atencao|^ponto de atencao|^riscos?/.test(normalized)) return 'attention'
  if (/^proximo passo|^proximos passos|^checklist|^como fazer|^como comecar|^comece assim/.test(normalized)) return 'nextSteps'

  return null
}

function pushStructuredValue(parsed: ParsedStructuredAnswer, key: keyof ParsedStructuredAnswer, value: string) {
  const cleaned = sanitizeAnswerText(value)
  if (!cleaned) {
    return
  }

  if (key === 'direct') {
    parsed.direct = parsed.direct ? `${parsed.direct} ${cleaned}`.trim() : cleaned
    return
  }

  const bucket = parsed[key]
  if (Array.isArray(bucket) && !bucket.includes(cleaned)) {
    bucket.push(cleaned)
  }
}

function formatStructuredAnswer(input: {
  direct: string
  deliverables: string[]
  attention: string[]
  nextSteps: string[]
}) {
  const lines = [`RESPOSTA DIRETA: ${sanitizeAnswerText(input.direct) || 'Pergunte de forma mais especifica sobre esta materia.'}`]
  const deliverables = formatSectionItems(cleanDeliverableItems(input.deliverables))
  const attention = formatSectionItems(cleanAttentionItems(input.attention))
  const nextSteps = formatSectionItems(cleanNextStepItems(input.nextSteps))
  if (deliverables) {
    lines.push(`O QUE ENTREGAR: ${deliverables}`)
  }
  if (attention) {
    lines.push(`ATENCAO: ${attention}`)
  }
  if (nextSteps) {
    lines.push(`PROXIMO PASSO: ${nextSteps}`)
  }

  return lines.join('\n')
}

function formatSectionItems(items: string[]) {
  const visibleItems = dedupeItems(items.map((item) => sanitizeAnswerText(item))).filter(Boolean)
  if (visibleItems.length === 0) {
    return ''
  }

  return visibleItems.slice(0, 3).map((item) => `- ${item}`).join(' ')
}

function buildSuggestedQuestions(intent: QuestionIntent) {
  if (intent === 'deliverable') {
    return ['Me faca um checklist', 'O que pode me fazer perder pontos?', 'Como eu organizo essa entrega?']
  }

  if (intent === 'tool_usage') {
    return ['Isso e obrigatorio ou opcional?', 'Me faca um checklist sem usar codigo', 'Como faco isso sem me perder?']
  }

  if (intent === 'smalltalk_or_noise') {
    return ['O que preciso entregar?', 'Me faca um checklist', 'O que pode me fazer perder pontos?']
  }

  if (intent === 'off_topic_learning') {
    return ['Explique este trabalho de forma simples', 'Como aplico isso nesta atividade?', 'Me faca um checklist']
  }

  if (intent === 'next_steps' || intent === 'explanation' || intent === 'unknown') {
    return ['Me faca um checklist', 'Explique este trabalho de forma simples', 'O que preciso entregar?']
  }

  return ['O que preciso entregar?', 'Me faca um checklist', 'O que pode me fazer perder pontos?']
}

function rankChunks(chunks: PublishedKnowledgeChunk[], question: string, intent: QuestionIntent) {
  const tokens = tokenize(question)
  const ranked = chunks
    .map((chunk) => ({
      chunk,
      score: tokens.reduce((total, token) => {
        let nextTotal = total
        if (normalizeText(chunk.text).includes(token)) nextTotal += 1
        if (chunk.keywords.map((item) => normalizeText(item)).includes(token)) nextTotal += 2
        return nextTotal
      }, 0) + sourceTypeIntentBoost(chunk.sourceType, intent, question),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.chunk)

  if (ranked.length > 0) {
    return ranked
  }

  return chunks
    .map((chunk) => ({
      chunk,
      score: fallbackChunkScore(chunk, intent),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.chunk)
}

function tokenize(value: string) {
  return normalizeText(value)
    .split(/[^a-z0-9]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3 || /^\d+$/.test(item))
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function sanitizeAnswerText(value: string) {
  return value
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^>\s*/g, '')
    .replace(/^#{1,6}\s*/g, '')
    .replace(/\s*\|\s*/g, ' - ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasActionableStep(values: string[]) {
  return values.some((value) => /\b(abra|prepare|valide|monte|revise|confirme|ignore|foco|siga|use|envie|verifique)\b/i.test(value))
}

function dedupeItems(values: Array<string | undefined>) {
  const seen = new Set<string>()
  const items: string[] = []

  for (const value of values) {
    const cleaned = sanitizeAnswerText(value ?? '')
    if (!cleaned) {
      continue
    }

    const key = normalizeText(cleaned)
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    items.push(cleaned)
  }

  return items
}

function extractDeliverableSignals(text: string) {
  const normalized = sanitizeAnswerText(text)
  const matches = [
    /apresenta(?:cao|ção).*?pdf/gi,
    /formulario.*?pdf/gi,
    /questionario.*?pdf/gi,
    /pesquisa.*?pdf/gi,
    /base de dados.*?(?:excel|xlsx)/gi,
    /planilha.*?(?:excel|xlsx)/gi,
    /arquivo\s+"[^"]+"/gi,
  ]

  const results: string[] = []
  for (const pattern of matches) {
    const found = normalized.match(pattern) ?? []
    results.push(...found.map((item) => normalizeDeliverableSignal(item)))
  }

  return cleanDeliverableItems(results)
}

function extractAttentionSignals(text: string) {
  const sentences = sanitizeAnswerText(text)
    .split(/\.\s+|\n+/)
    .map((item) => sanitizeAnswerText(item))
    .filter(Boolean)

  return cleanAttentionItems(
    sentences.filter((item) => /\b(atencao|cuidado|evite|risco|penalidade|erro|abnt|links?|respondentes reais|dados ficticios|matricula|nome completo)\b/i.test(item)),
  )
}

function extractNextStepSignals(text: string) {
  const sentences = sanitizeAnswerText(text)
    .split(/\.\s+|\n+/)
    .map((item) => sanitizeAnswerText(item))
    .filter(Boolean)

  return cleanNextStepItems(
    sentences.filter((item) => /\b(comece|abra|prepare|monte|revise|confirme|valide|envie|faca|faça|organize|retome|estude|pergunte)\b/i.test(item)),
  )
}

function extractToolLabel(question: string) {
  const normalized = normalizeText(question)
  if (/\bpython\b/.test(normalized)) return 'Python'
  if (/\br\b/.test(normalized)) return 'R'
  if (/\bexcel\b|\bplanilha\b/.test(normalized)) return 'Excel'
  if (/\bcodigo\b|\bscript\b/.test(normalized)) return 'codigo'
  return 'essa ferramenta'
}

function getToolUsageContext(input: {
  topic: PublicTopic
  citations: Citation[]
  question: string
}): ToolUsageContext {
  const toolLabel = extractToolLabel(input.question)
  const toolKey = normalizeText(toolLabel)
  const contextualText = normalizeText([
    input.topic.summary,
    input.topic.agentMemory?.overview,
    ...(input.topic.agentMemory?.keyFacts ?? []),
    ...((normalizeLearning(input.topic.learning)?.learningTopics ?? []).flatMap((item) => [item.title, item.explanation, item.commonDifficulty, item.studyStrategy])),
    ...((normalizeLearning(input.topic.learning)?.frequentQuestions ?? []).flatMap((item) => [item.question, item.answer])),
    ...input.citations.map((item) => item.snippet),
  ].filter(Boolean).join(' '))
  const requirementText = normalizeText([
    ...(input.topic.agentMemory?.deliverables ?? []),
    ...input.citations.map((item) => item.snippet),
  ].filter(Boolean).join(' '))
  const mentionPattern = toolKey !== 'essa ferramenta' ? new RegExp(`\\b${toolKey}\\b`, 'i') : null
  const requirementPattern = toolKey !== 'essa ferramenta'
    ? new RegExp(`\\b${toolKey}\\b.{0,80}\\b(obrigatori|deve|precisa|use|utilize|script|codigo|program|xlsx|excel|planilha|envie|entreg)`, 'i')
    : null

  return {
    toolLabel,
    toolKey,
    hasMentionInContext: Boolean(mentionPattern?.test(contextualText)),
    hasExplicitRequirement: Boolean(requirementPattern?.test(requirementText)),
  }
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

function shouldAttachTopicImages(question: string) {
  return /\b(print|imagem|screenshot|tela|diagrama|grafico)\b/i.test(question)
}

function buildSafeSummary(summary: string, deliverables: string[], nextSteps: string[]) {
  const cleaned = sanitizeAnswerText(summary)
  if (cleaned && !looksLikeBadPublicOutput(cleaned)) {
    return cleaned
  }
  if (deliverables[0]) {
    return `Os entregaveis principais sao ${deliverables.slice(0, 2).join(' e ')}.`
  }
  if (nextSteps[0]) {
    return nextSteps[0]
  }
  return 'Pergunte de forma mais especifica sobre esta materia.'
}

function buildContextOverview(topic: PublicTopic, citations: Citation[]) {
  const candidates = [
    topic.summary,
    topic.agentMemory?.overview,
    ...citations.map((item) => item.snippet),
  ]
    .map((item) => cleanProviderSnippet(item ?? ''))
    .filter(Boolean)

  return dedupeItems(candidates).find((item) => !looksLikeRawMetadata(item)) ?? ''
}

function cleanProviderSnippet(value: string) {
  return sanitizeAnswerText(value)
    .replace(/\b(pergunta|resposta):\s*/gi, '')
    .replace(/\b(prazo|data|horario)\b.*$/gi, '')
    .replace(/\b(link de detalhe|status|curso|modulo sugerido|arquivos baixados)\b.*$/gi, '')
    .replace(/https?:\/\/\S+/gi, '')
    .trim()
}

function cleanDeliverableItems(values: string[]) {
  return dedupeItems(values.map((item) => normalizeDeliverableSignal(item)).filter(isUsefulDeliverableSignal))
}

function cleanAttentionItems(values: string[]) {
  return dedupeItems(
    values
      .flatMap((item) => sanitizeAnswerText(item).split(/\s*;\s*|\.\s+(?=[A-Z0-9])/))
      .map((item) => sanitizeAnswerText(item))
      .map((item) => item.replace(/^pontos?\s+de\s+atencao:\s*/i, ''))
      .map((item) => item.replace(/\b(atraso superior a 15 minutos|07:45|08:00|23:59)\b.*$/i, ''))
      .map((item) => item.replace(/\b(link de detalhe|teams\.microsoft)\b.*$/i, ''))
      .filter((item) => item.length > 10 && item.length <= 120)
      .filter((item) => !looksLikeRawMetadata(item))
      .filter((item) => !/\b(prazo|horario|data)\b/i.test(item)),
  )
}

function cleanNextStepItems(values: string[]) {
  return dedupeItems(
    values
      .flatMap((item) => sanitizeAnswerText(item).split(/\s*;\s*|\.\s+(?=[A-Z0-9])/))
      .map((item) => sanitizeAnswerText(item.replace(/^\d+\.\s*/, '')))
      .map((item) => item.replace(/\b(link de detalhe|teams\.microsoft)\b.*$/i, ''))
      .filter((item) => item.length > 12 && item.length <= 120)
      .filter((item) => !looksLikeRawMetadata(item)),
  )
}

function cleanFullAnswerItems(values: string[]) {
  return dedupeItems(
    values
      .flatMap((item) => sanitizeAnswerText(item).split(/\n+|\s*;\s*/))
      .map((item) => sanitizeAnswerText(item))
      .filter((item) => item.length > 16 && item.length <= 180)
      .filter((item) => !looksLikeBadPublicOutput(item)),
  )
}

function normalizeDeliverableSignal(value: string) {
  const cleaned = sanitizeAnswerText(value)
    .replace(/^arquivo:\s*/i, '')
    .replace(/\.pdf$/i, ' PDF')
    .replace(/\.docx$/i, '')
    .replace(/\.xlsx$/i, ' Excel')
    .replace(/[_-]+/g, ' ')
    .trim()

  if (/(apresenta|slide)/i.test(cleaned) && /pdf/i.test(cleaned)) return 'Apresentacao em PDF'
  if (/(formular|questionario|pesquisa)/i.test(cleaned) && /pdf/i.test(cleaned)) return 'Formulario ou pesquisa em PDF'
  if (/(base de dados|planilha|excel|xlsx)/i.test(cleaned)) return 'Base de dados em Excel'
  if (/(apresentacao oral|oral individual|apresenta[cç][aã]o oral)/i.test(cleaned)) return 'Apresentacao oral individual'
  if (/respondentes reais|pesquisa em grupo/i.test(cleaned)) return 'Pesquisa com respondentes reais'
  return cleaned
}

function isUsefulDeliverableSignal(value: string) {
  const cleaned = sanitizeAnswerText(value)
  return Boolean(cleaned)
    && cleaned.length >= 4
    && cleaned.length <= 60
    && !looksLikeRawMetadata(cleaned)
    && !/\b(prazo|horario|data|status|curso|modulo|professor|teams\.microsoft|checkpoint.*docx|\.py)\b/i.test(cleaned)
}

function looksLikeBadPublicOutput(value: string) {
  const normalized = sanitizeAnswerText(value)
  return !normalized
    || looksLikeRawMetadata(normalized)
    || /\bnao encontrei isso no material\b/i.test(normalized)
    || /\bnao sei\b/i.test(normalized)
    || /\b(prazo|07:45|08:00|23:59|atraso superior a 15 minutos)\b/i.test(normalized)
}

function sourceTypeIntentBoost(sourceType: PublishedKnowledgeChunk['sourceType'], intent: QuestionIntent, question: string) {
  if (intent === 'deliverable' && sourceType === 'deliverable') return 3
  if ((intent === 'grading' || intent === 'format') && sourceType === 'faq') return 2
  if ((intent === 'summary' || intent === 'explanation') && sourceType === 'summary') return 2
  if (intent === 'tool_usage' && /\bpython\b|\br\b|\bcodigo\b|\bscript\b/i.test(question) && sourceType === 'content') return 2
  if (intent === 'smalltalk_or_noise' && sourceType === 'summary') return 1
  return 0
}

function fallbackChunkScore(chunk: PublishedKnowledgeChunk, intent: QuestionIntent) {
  if (intent === 'deliverable' && chunk.sourceType === 'deliverable') return 4
  if ((intent === 'summary' || intent === 'explanation') && (chunk.sourceType === 'summary' || chunk.sourceType === 'overview')) return 3
  if (intent === 'tool_usage' && chunk.sourceType === 'content') return 2
  if (chunk.sourceType === 'faq') return 1
  return 0
}

function looksLikeRawMetadata(value: string) {
  return /(teams\.microsoft|status:|curso:|modulo sugerido|professor|tecnologo|disciplina:|checkpoint.*docx|arquivo\s+"|arquivos baixados|link de detalhe)/i.test(value)
}

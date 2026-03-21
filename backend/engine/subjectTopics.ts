import fs from 'node:fs/promises'
import path from 'node:path'
import { botConfig, type AssignmentItem } from '@fiapauto/bots'
import { ensureDir, readJsonFile, writeJsonFile } from '../database/fs.ts'
import { readLlmDebugHistory } from '../connections/llm/llmDebugStore.ts'
import {
  llmConfig,
  postLlmChat,
  uploadFilesToLlm,
  type LlmDocument,
  type LlmImage,
} from '../connections/llm/llmClient.ts'
import { appendConversationTurn, readConversationState } from './conversationStateStore.ts'
import { buildDeterministicResponse } from './deterministicResponder.ts'
import { classifyQuestionIntent } from './questionIntentClassifier.ts'
import { buildTopicContextBundle, type TopicCitation } from './topicContextBuilder.ts'
import { routeAssistantChat } from '../connections/llm/providerRouter.ts'

type WorkspaceReport = {
  assignments: AssignmentItem[]
}

export type TopicAttachment = {
  path: string
  name: string
}

export type TopicFaqItem = {
  question: string
  answer: string
}

export type TopicAgentMemory = {
  overview: string
  deliverables: string[]
  deadlines: string[]
  faq: TopicFaqItem[]
  keyFacts: string[]
  answerStyle: string
  fallbackPolicy: string
  sourceSnippets: string[]
}

export type TopicLearningConcept = {
  title: string
  content: string
}

export type TopicLearning = {
  frequentQuestions: TopicFaqItem[]
  simpleConcepts: TopicLearningConcept[]
  quickTips: string[]
}

export type SubjectTopic = {
  id: string
  title: string
  course: string
  moduleKey: string
  status: AssignmentItem['status']
  dueText: string
  detailUrl?: string
  assignmentIds: string[]
  attachments: TopicAttachment[]
  screenshots: string[]
  contentText: string
  summary: string
  summaryGeneratedAt?: string
  agentMemory: TopicAgentMemory | null
  agentMemoryGeneratedAt?: string
  learning: TopicLearning | null
  learningGeneratedAt?: string
  lastAskedAt?: string
  updatedAt: string
  warnings: string[]
  sourceSignature: string
}

export type TopicListItem = Pick<
  SubjectTopic,
  | 'id'
  | 'title'
  | 'course'
  | 'moduleKey'
  | 'status'
  | 'dueText'
  | 'summary'
  | 'summaryGeneratedAt'
  | 'agentMemoryGeneratedAt'
  | 'updatedAt'
> & {
  attachmentCount: number
  screenshotCount: number
  primaryScreenshot?: string
}

export type TopicSummaryResult = {
  topicId: string
  moduleKey: string
  summary: string
  warnings: string[]
  filesUsed: string[]
  generatedAt: string
}

export type TopicAskResult = {
  topicId: string
  answer: string
  moduleKey: string
  warnings: string[]
  usedFallback: boolean
  answeredAt: string
  confidence: 'high' | 'medium' | 'low'
  strategyUsed: 'memory' | 'rag_llm' | 'provider_fallback' | 'deterministic'
  providerUsed?: 'gemini' | 'ollama' | 'local'
  fallbackLevel: number
  citations: TopicCitation[]
  suggestedQuestions: string[]
  nextSteps: string[]
}

export type TopicQuestionHistoryItem = {
  id: string
  question: string
  answer: string
  usedFallback: boolean
  answeredAt: string
}

const supportedTextExtensions = new Set([
  '.txt',
  '.md',
  '.json',
  '.csv',
  '.log',
  '.py',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.r',
  '.yml',
  '.yaml',
])

export async function syncTopicsFromAssignments() {
  await ensureDir(botConfig.subjectsDir)

  const report = await readJsonFile<WorkspaceReport>(botConfig.assignmentsFile, { assignments: [] })
  const existingTopics = await readTopicsIndex()
  const existingMap = new Map(existingTopics.map((topic) => [topic.id, topic]))
  const nextTopics: SubjectTopic[] = []

  for (const assignment of report.assignments) {
    const topicId = slugify(assignment.title || assignment.id || `topic-${Date.now()}`)
    const sourceSignature = buildSourceSignature(assignment)
    const previous = existingMap.get(topicId)

    const attachmentPaths = dedupePaths(assignment.downloadedFiles.filter(Boolean))
    const attachments = attachmentPaths.map((filePath) => ({
      path: filePath,
      name: path.basename(filePath),
    }))

    const screenshots = await syncTopicScreenshots(topicId, assignment)
    const nextContentResult =
      previous && previous.sourceSignature === sourceSignature && !contentLooksThin(previous.contentText)
        ? {
            contentText: previous.contentText,
            warnings: previous.warnings,
          }
        : await buildTopicContentSafely(topicId, assignment)
    const contentResult = chooseBestContentResult(previous, nextContentResult)

    await writeTopicContent(topicId, contentResult.contentText)

    const summaryState = await readStoredSummary(topicId)
    const memoryState = await readStoredMemory(topicId)
    const learningState = await readStoredLearning(topicId)
    const normalizedSummary = normalizePersistedSummary(summaryState.summary ?? previous?.summary ?? '', assignment.dueText)
    if (summaryState.summary && normalizedSummary && normalizedSummary !== summaryState.summary) {
      await writeSummaryFile(topicId, {
        summary: normalizedSummary,
        generatedAt: summaryState.generatedAt ?? new Date().toISOString(),
      })
    }
    const baseTopic: SubjectTopic = {
      id: topicId,
      title: assignment.title,
      course: assignment.course,
      moduleKey: detectModuleKey(assignment),
      status: assignment.status,
      dueText: assignment.dueText,
      detailUrl: assignment.detailUrl,
      assignmentIds: [assignment.id],
      attachments,
      screenshots,
      contentText: contentResult.contentText,
      summary: normalizedSummary,
      summaryGeneratedAt: summaryState.generatedAt ?? previous?.summaryGeneratedAt,
      agentMemory: memoryState.memory ?? previous?.agentMemory ?? null,
      agentMemoryGeneratedAt: memoryState.generatedAt ?? previous?.agentMemoryGeneratedAt,
      learning: null,
      learningGeneratedAt: learningState.generatedAt ?? previous?.learningGeneratedAt,
      lastAskedAt: previous?.lastAskedAt,
      updatedAt:
        previous && previous.sourceSignature === sourceSignature
          ? previous.updatedAt
          : new Date().toISOString(),
      warnings: contentResult.warnings,
      sourceSignature,
    }

    const learningMemory = baseTopic.agentMemory ?? buildFallbackMemory(baseTopic)
    const shouldRefreshLearning =
      !learningState.learning ||
      !previous ||
      previous.sourceSignature !== sourceSignature ||
      !previous.learningGeneratedAt
    const learningGeneratedAt = shouldRefreshLearning ? new Date().toISOString() : learningState.generatedAt ?? previous?.learningGeneratedAt
    const learning = shouldRefreshLearning
      ? buildAutomaticTopicLearning(baseTopic, learningMemory)
      : learningState.learning ?? null

    if (learning && learningGeneratedAt && (shouldRefreshLearning || !learningState.learning)) {
      await writeLearningFile(topicId, {
        learning,
        generatedAt: learningGeneratedAt,
      })
    }

    const topic: SubjectTopic = {
      ...baseTopic,
      learning,
      learningGeneratedAt,
    }

    nextTopics.push(topic)
  }

  await writeTopicsIndex(nextTopics)
  return nextTopics
}

export async function listTopics() {
  const topics = await syncTopicsFromAssignments()

  return topics.map((topic) => ({
    id: topic.id,
    title: topic.title,
    course: topic.course,
    moduleKey: topic.moduleKey,
    status: topic.status,
    dueText: topic.dueText,
    summary: topic.summary,
    summaryGeneratedAt: topic.summaryGeneratedAt,
    agentMemoryGeneratedAt: topic.agentMemoryGeneratedAt,
    updatedAt: topic.updatedAt,
    attachmentCount: topic.attachments.length,
    screenshotCount: topic.screenshots.length,
    primaryScreenshot: topic.screenshots[0],
  })) satisfies TopicListItem[]
}

export async function getTopicById(topicId: string) {
  const topics = await syncTopicsFromAssignments()
  const topic = topics.find((item) => item.id === topicId)

  if (!topic) {
    throw new Error('topic_not_found')
  }

  return topic
}

export async function generateTopicSummary(topicId: string, force = false) {
  const topics = await syncTopicsFromAssignments()
  const topic = topics.find((item) => item.id === topicId)

  if (!topic) {
    throw new Error('topic_not_found')
  }

  if (topic.summary && topic.summaryGeneratedAt && !force) {
    return {
      topicId: topic.id,
      moduleKey: topic.moduleKey,
      summary: topic.summary,
      warnings: topic.warnings,
      filesUsed: topic.attachments.map((item) => item.path),
      generatedAt: topic.summaryGeneratedAt,
    } satisfies TopicSummaryResult
  }

  const documents = buildTopicDocuments(topic)
  const images = await buildTopicImages(topic)
  const jobId = `topic-summary-${topic.id}-${Date.now()}`
  const message = [
    'Voce e um assistente academico objetivo.',
    'Resuma o topico em portugues do Brasil.',
    'Use no maximo 8 linhas.',
    'Inclua: objetivo, entregaveis, prazo, pontos de atencao e contexto da materia.',
    'Se algo nao estiver claro, diga explicitamente que nao foi encontrado.',
    'Nao use markdown.',
  ].join(' ')

  const response = await postLlmChat({
    jobId,
    topicId: topic.id,
    mode: 'default',
    message,
    documents,
    images,
  })

  const generatedAt = new Date().toISOString()
  const summary = normalizePersistedSummary(response.content.trim() || buildDeterministicSummary(topic), topic.dueText)

  await writeSummaryFile(topic.id, {
    summary,
    generatedAt,
  })
  const learning = buildAutomaticTopicLearning(
    {
      ...topic,
      summary,
      summaryGeneratedAt: generatedAt,
    },
    topic.agentMemory ?? buildFallbackMemory({ ...topic, summary }),
  )
  await writeLearningFile(topic.id, {
    learning,
    generatedAt,
  })

  await updateTopicRecord(topic.id, (current) => ({
    ...current,
    summary,
    summaryGeneratedAt: generatedAt,
    learning,
    learningGeneratedAt: generatedAt,
    updatedAt: generatedAt,
  }))

  return {
    topicId: topic.id,
    moduleKey: topic.moduleKey,
    summary,
    warnings: topic.warnings,
    filesUsed: topic.attachments.map((item) => item.path),
    generatedAt,
  } satisfies TopicSummaryResult
}

export async function generateTopicMemory(topicId: string, force = false) {
  const topic = await getTopicById(topicId)
  const sanitizedExistingMemory = topic.agentMemory ? sanitizeTopicMemory(topic.agentMemory) : null

  if (sanitizedExistingMemory && topic.agentMemoryGeneratedAt && !force) {
    if (sanitizedExistingMemory !== topic.agentMemory) {
      await writeMemoryFile(topicId, {
        memory: sanitizedExistingMemory,
        generatedAt: topic.agentMemoryGeneratedAt,
      })
    }
    return sanitizedExistingMemory
  }

  const summaryResult = await generateTopicSummary(topicId, false)
  const freshTopic = await getTopicById(topicId)
  const jobId = `topic-memory-${topicId}-${Date.now()}`
  const prompt = [
    'Voce vai montar uma memoria persistida para responder perguntas sobre uma atribuicao academica.',
    'Responda somente em JSON valido.',
    'Use exatamente estas chaves:',
    'overview, deliverables, deadlines, faq, keyFacts, answerStyle, fallbackPolicy, sourceSnippets.',
    'faq deve ser um array de objetos com question e answer.',
    'Nao invente informacoes ausentes.',
    `Resumo atual: ${summaryResult.summary}`,
  ].join('\n')

  const response = await postLlmChat({
    jobId,
    topicId,
    mode: 'default',
    message: prompt,
    documents: buildTopicDocuments(freshTopic),
    images: [],
  })

  const generatedAt = new Date().toISOString()
  const parsed = parseMemoryPayload(response.content)
  const memory = parsed ?? buildFallbackMemory(freshTopic)
  const sanitizedMemory = sanitizeTopicMemory(memory)

  await writeMemoryFile(topicId, {
    memory: sanitizedMemory,
    generatedAt,
  })
  const learning = buildAutomaticTopicLearning(
    {
      ...freshTopic,
      summary: summaryResult.summary,
      agentMemory: sanitizedMemory,
      agentMemoryGeneratedAt: generatedAt,
    },
    sanitizedMemory,
  )
  await writeLearningFile(topicId, {
    learning,
    generatedAt,
  })

  await updateTopicRecord(topicId, (current) => ({
    ...current,
    agentMemory: sanitizedMemory,
    agentMemoryGeneratedAt: generatedAt,
    learning,
    learningGeneratedAt: generatedAt,
    updatedAt: generatedAt,
  }))

  return sanitizedMemory
}

export async function askTopic(input: { topicId: string; question: string }) {
  const topic = await getTopicById(input.topicId)
  const memory = await generateTopicMemory(topic.id, false)
  const conversation = await readConversationState(topic.id)
  const context = await buildTopicContextBundle({
    topic,
    memory,
    question: input.question,
    conversation,
  })
  const localAnswer = answerFromLocalMemory(topic, memory, input.question)
  const answeredAt = new Date().toISOString()
  const intent = classifyQuestionIntent(input.question)

  const shouldPreferCloudAnswer =
    intent === 'grading' || intent === 'format' || intent === 'explanation' || intent === 'numbered_item' || intent === 'unknown'
  const isGreeting = intent === 'greeting'

  if (isGreeting) {
    const answer = `Posso te ajudar com ${topic.title}. Se quiser, pergunte sobre prazo, entregaveis, checklist, criterios de avaliacao ou um item especifico do trabalho.`
    await appendConversationTurn(topic.id, {
      question: input.question,
      answer,
      answeredAt,
    })
    return {
      topicId: topic.id,
      answer,
      moduleKey: topic.moduleKey,
      warnings: topic.warnings,
      usedFallback: false,
      answeredAt,
      confidence: 'medium',
      strategyUsed: 'memory',
      providerUsed: 'local',
      fallbackLevel: 0,
      citations: [],
      suggestedQuestions: ['O que preciso entregar?', 'Qual e o prazo?', 'Como resolver o item 4?'],
      nextSteps: ['Escolha uma duvida objetiva sobre esse trabalho para eu te orientar melhor.'],
    } satisfies TopicAskResult
  }

  if (localAnswer.confidence >= 0.72 && !shouldPreferCloudAnswer) {
    const deterministic = buildDeterministicResponse({
      topic,
      question: input.question,
      intent,
      context,
    })

    await updateTopicRecord(topic.id, (current) => ({
      ...current,
      lastAskedAt: answeredAt,
      updatedAt: answeredAt,
    }))
    await appendConversationTurn(topic.id, {
      question: input.question,
      answer: localAnswer.answer,
      answeredAt,
    })

    return {
      topicId: topic.id,
      answer: localAnswer.answer,
      moduleKey: topic.moduleKey,
      warnings: topic.warnings,
      usedFallback: false,
      answeredAt,
      confidence: localAnswer.confidence >= 0.88 ? 'high' : 'medium',
      strategyUsed: 'memory',
      providerUsed: 'local',
      fallbackLevel: 0,
      citations: deterministic.citations,
      suggestedQuestions: deterministic.suggestedQuestions,
      nextSteps: deterministic.nextSteps,
    } satisfies TopicAskResult
  }

  const deterministic = buildDeterministicResponse({
    topic,
    question: input.question,
    intent,
    context,
  })
  const prompt = buildAssistantPrompt(topic, input.question, context)

  try {
    const providerResponse = await routeAssistantChat({
      jobId: `topic-ask-${topic.id}-${Date.now()}`,
      topicId: topic.id,
      prompt,
      documents: context.documents.map((item) => ({
        name: item.name,
        content: item.content.slice(0, 12000),
      })),
      images: [],
    })

    const answer = normalizeAssistantAnswer(providerResponse.answer || deterministic.answer)
    await recordTopicQuestionAnswer(topic.id, input.question, answer, {
      answeredAt,
      usedFallback: providerResponse.strategyUsed !== 'rag_llm',
      persistToFaq: true,
    })
    await appendConversationTurn(topic.id, {
      question: input.question,
      answer,
      answeredAt,
    })

    return {
      topicId: topic.id,
      answer,
      moduleKey: topic.moduleKey,
      warnings: topic.warnings,
      usedFallback: providerResponse.strategyUsed !== 'rag_llm',
      answeredAt,
      confidence: context.citations.length >= 3 ? 'high' : 'medium',
      strategyUsed: providerResponse.strategyUsed,
      providerUsed: providerResponse.providerUsed,
      fallbackLevel: providerResponse.fallbackLevel,
      citations: deterministic.citations,
      suggestedQuestions: deterministic.suggestedQuestions,
      nextSteps: deterministic.nextSteps,
    } satisfies TopicAskResult
  } catch {
    const answer = normalizeAssistantAnswer(deterministic.answer)
    await recordTopicQuestionAnswer(topic.id, input.question, answer, {
      answeredAt,
      usedFallback: true,
      persistToFaq: false,
    })
    await appendConversationTurn(topic.id, {
      question: input.question,
      answer,
      answeredAt,
    })

    return {
      topicId: topic.id,
      answer,
      moduleKey: topic.moduleKey,
      warnings: topic.warnings,
      usedFallback: true,
      answeredAt,
      confidence: deterministic.confidence,
      strategyUsed: 'deterministic',
      providerUsed: 'local',
      fallbackLevel: 2,
      citations: deterministic.citations,
      suggestedQuestions: deterministic.suggestedQuestions,
      nextSteps: deterministic.nextSteps,
    } satisfies TopicAskResult
  }
}

export async function getTopicDebug(topicId: string) {
  const topic = await getTopicById(topicId)
  return {
    topic,
    history: await readTopicQuestionHistory(topicId),
    events: await readLlmDebugHistory(100, topicId),
    llm: llmConfig(),
  }
}

export async function recordTopicQuestionAnswer(
  topicId: string,
  question: string,
  answer: string,
  options?: {
    answeredAt?: string
    usedFallback?: boolean
    persistToFaq?: boolean
  },
) {
  const topic = await getTopicById(topicId)
  const currentMemory = topic.agentMemory ?? buildFallbackMemory(topic)
  const answeredAt = options?.answeredAt ?? new Date().toISOString()
  const updatedMemory = mergeMemoryWithAnswer(currentMemory, question, answer, topic.contentText, {
    persistToFaq: options?.persistToFaq !== false,
  })
  const historyEntry: TopicQuestionHistoryItem = {
    id: crypto.randomUUID(),
    question,
    answer,
    usedFallback: options?.usedFallback === true,
    answeredAt,
  }

  await writeMemoryFile(topic.id, {
    memory: updatedMemory,
    generatedAt: answeredAt,
  })

  await appendTopicQuestionHistory(topic.id, historyEntry)

  await updateTopicRecord(topic.id, (current) => ({
    ...current,
    agentMemory: updatedMemory,
    agentMemoryGeneratedAt: answeredAt,
    lastAskedAt: answeredAt,
    updatedAt: answeredAt,
  }))

  return {
    topic: {
      ...topic,
      agentMemory: updatedMemory,
      agentMemoryGeneratedAt: answeredAt,
      lastAskedAt: answeredAt,
      updatedAt: answeredAt,
    },
    memory: updatedMemory,
    historyEntry,
  }
}

async function readTopicsIndex() {
  return readJsonFile<SubjectTopic[]>(botConfig.topicsFile, [])
}

async function writeTopicsIndex(topics: SubjectTopic[]) {
  await writeJsonFile(botConfig.topicsFile, topics)
}

async function updateTopicRecord(topicId: string, updater: (topic: SubjectTopic) => SubjectTopic) {
  const topics = await readTopicsIndex()
  const nextTopics = topics.map((topic) => (topic.id === topicId ? updater(topic) : topic))
  await writeTopicsIndex(nextTopics)
}

async function readStoredSummary(topicId: string) {
  const value = await readJsonFile<{ summary?: string; generatedAt?: string }>(
    path.join(getTopicDir(topicId), 'summary.json'),
    {},
  )

  return {
    summary: typeof value.summary === 'string' ? value.summary : undefined,
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : undefined,
  }
}

async function readStoredMemory(topicId: string) {
  const value = await readJsonFile<{ memory?: TopicAgentMemory; generatedAt?: string }>(
    path.join(getTopicDir(topicId), 'memory.json'),
    {},
  )

  return {
    memory: isTopicMemory(value.memory) ? value.memory : undefined,
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : undefined,
  }
}

async function readStoredLearning(topicId: string) {
  const value = await readJsonFile<{ learning?: TopicLearning; generatedAt?: string }>(
    path.join(getTopicDir(topicId), 'learning.json'),
    {},
  )

  return {
    learning: isTopicLearning(value.learning) ? value.learning : undefined,
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : undefined,
  }
}

async function readTopicQuestionHistory(topicId: string) {
  return readJsonFile<TopicQuestionHistoryItem[]>(path.join(getTopicDir(topicId), 'qa-history.json'), [])
}

async function writeSummaryFile(topicId: string, value: { summary: string; generatedAt: string }) {
  await writeJsonFile(path.join(getTopicDir(topicId), 'summary.json'), value)
}

async function writeMemoryFile(topicId: string, value: { memory: TopicAgentMemory; generatedAt: string }) {
  await writeJsonFile(path.join(getTopicDir(topicId), 'memory.json'), value)
}

async function writeLearningFile(topicId: string, value: { learning: TopicLearning; generatedAt: string }) {
  await writeJsonFile(path.join(getTopicDir(topicId), 'learning.json'), value)
}

async function appendTopicQuestionHistory(topicId: string, entry: TopicQuestionHistoryItem) {
  const history = await readTopicQuestionHistory(topicId)
  const nextHistory = [entry, ...history].slice(0, 40)
  await writeJsonFile(path.join(getTopicDir(topicId), 'qa-history.json'), nextHistory)
}

async function writeTopicContent(topicId: string, contentText: string) {
  await ensureDir(getTopicDir(topicId))
  await fs.writeFile(path.join(getTopicDir(topicId), 'content.txt'), contentText, 'utf-8')
}

async function buildTopicContentText(topicId: string, assignment: AssignmentItem) {
  const warnings: string[] = []
  const blocks: string[] = [
    [
      `Titulo: ${assignment.title}`,
      `Curso: ${assignment.course || 'nao identificado'}`,
      `Status: ${assignment.status}`,
      `Prazo: ${assignment.dueText || 'nao encontrado'}`,
      `Link de detalhe: ${assignment.detailUrl || 'nao encontrado'}`,
      `Modulo sugerido: ${detectModuleKey(assignment)}`,
      `Arquivos baixados: ${assignment.downloadedFiles.map((item) => path.basename(item)).join(', ') || 'nenhum'}`,
    ].join('\n'),
  ]

  const uploadCandidates: string[] = []

  for (const filePath of assignment.downloadedFiles) {
    const localText = await tryReadLocalTextFile(filePath)
    if (localText) {
      blocks.push(`Arquivo: ${localText.name}\n${localText.content}`)
      continue
    }

    uploadCandidates.push(filePath)
  }

  if (uploadCandidates.length > 0) {
    const uploadResult = await uploadFilesToLlm(`topic-upload-${topicId}-${Date.now()}`, uploadCandidates, topicId)
    warnings.push(...uploadResult.errors)
    blocks.push(...uploadResult.documents.map((item) => `Arquivo: ${item.name}\n${item.content}`))
  }

  if (warnings.length > 0) {
    blocks.push(`Avisos de ingestao: ${warnings.join(' | ')}`)
  }

  return {
    contentText: blocks.join('\n\n').slice(0, 60000),
    warnings,
  }
}

async function buildTopicContentSafely(topicId: string, assignment: AssignmentItem) {
  try {
    const result = await buildTopicContentText(topicId, assignment)
    if (contentLooksThin(result.contentText)) {
      const recovered = await recoverTopicContentFromDebugHistory(topicId)
      if (recovered) {
        return {
          contentText: recovered,
          warnings: result.warnings,
        }
      }
    }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'content_ingestion_failed'
    const recovered = await recoverTopicContentFromDebugHistory(topicId)
    return {
      contentText:
        recovered ??
        [
          `Titulo: ${assignment.title}`,
          `Curso: ${assignment.course || 'nao identificado'}`,
          `Status: ${assignment.status}`,
          `Prazo: ${assignment.dueText || 'nao encontrado'}`,
          `Link de detalhe: ${assignment.detailUrl || 'nao encontrado'}`,
          `Arquivos baixados: ${assignment.downloadedFiles.map((item) => path.basename(item)).join(', ') || 'nenhum'}`,
        ].join('\n'),
      warnings: [message],
    }
  }
}

async function tryReadLocalTextFile(filePath: string) {
  const extension = path.extname(filePath).toLowerCase()
  if (!supportedTextExtensions.has(extension)) {
    return null
  }

  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return {
      name: path.basename(filePath),
      content: content.slice(0, 24000),
    }
  } catch {
    return null
  }
}

async function syncTopicScreenshots(topicId: string, assignment: AssignmentItem) {
  const screenshotDir = path.join(getTopicDir(topicId), 'screenshots')
  await ensureDir(screenshotDir)

  const candidates = new Set<string>()

  for (const filePath of assignment.screenshotFiles ?? []) {
    if (filePath) {
      candidates.add(filePath)
    }
  }

  if (assignment.localFolder) {
    try {
      const files = await fs.readdir(assignment.localFolder)
      for (const fileName of files) {
        if (/\.(png|jpg|jpeg|webp)$/i.test(fileName)) {
          candidates.add(path.join(assignment.localFolder, fileName))
        }
      }
    } catch {
      // ignore local folder read failures
    }
  }

  const outputs: string[] = []

  for (const sourcePath of candidates) {
    try {
      const targetPath = path.join(screenshotDir, path.basename(sourcePath))
      await fs.copyFile(sourcePath, targetPath)
      outputs.push(targetPath)
    } catch {
      // ignore copy failures
    }
  }

  return dedupePaths(outputs)
}

function buildTopicDocuments(topic: SubjectTopic, memory?: TopicAgentMemory) {
  const documents: LlmDocument[] = [
    {
      name: `${topic.id}.content.txt`,
      content: topic.contentText.slice(0, 30000),
    },
  ]

  if (topic.summary) {
    documents.push({
      name: `${topic.id}.summary.txt`,
      content: topic.summary,
    })
  }

  if (memory) {
    documents.push({
      name: `${topic.id}.memory.json`,
      content: JSON.stringify(memory, null, 2),
    })
  }

  return documents
}

async function buildTopicImages(topic: SubjectTopic) {
  const images: LlmImage[] = []

  for (const screenshotPath of topic.screenshots.slice(0, 2)) {
    try {
      const bytes = await fs.readFile(screenshotPath)
      images.push({
        name: path.basename(screenshotPath),
        mime: guessMimeType(screenshotPath),
        data: bytes.toString('base64'),
      })
    } catch {
      // ignore unreadable screenshots
    }
  }

  return images
}

function answerFromLocalMemory(topic: SubjectTopic, memory: TopicAgentMemory, question: string) {
  const snippets = findRelevantSnippets(
    [memory.overview, ...memory.keyFacts, ...memory.deliverables, ...memory.deadlines, ...memory.sourceSnippets, topic.summary]
      .filter(Boolean)
      .join('\n'),
    question,
  )

  const faqMatch = memory.faq.find(
    (item) => isQuestionAnswerSafeForReuse(item.question, item.answer) && computeSimilarity(`${item.question} ${item.answer}`, question) >= 0.75,
  )
  if (faqMatch) {
    return {
      answer: faqMatch.answer,
      confidence: 0.92,
    }
  }

  if (snippets.length >= 2) {
    return {
      answer: snippets.slice(0, 3).join('\n'),
      confidence: 0.78,
    }
  }

  if (memory.overview) {
    return {
      answer: [memory.overview, ...snippets.slice(0, 2)].filter(Boolean).join('\n'),
      confidence: snippets.length > 0 ? 0.7 : 0.45,
    }
  }

  return {
    answer: buildDeterministicSummary(topic),
    confidence: 0.35,
  }
}

function buildAssistantPrompt(topic: SubjectTopic, question: string, context: {
  intent: string
  citations: TopicCitation[]
  keyFacts: string[]
  deadlineHints: string[]
  deliverableHints: string[]
  numberedHints: string[]
  conversationSummary: string
}) {
  return [
    'Voce e um assistente academico util, claro e honesto.',
    `Topico: ${topic.title}. Curso: ${topic.course || 'nao identificado'}.`,
    `Intencao principal da pergunta: ${context.intent}.`,
    `Pergunta do usuario: ${question}`,
    'Responda em portugues do Brasil, com tom natural, acolhedor e objetivo, em no maximo 8 linhas.',
    context.intent === 'numbered_item'
      ? 'Se a pergunta citar um item numerado, use como fonte principal apenas o trecho numerado recuperado. Explique exatamente esse item em linguagem simples, diga o que a pessoa precisa fazer e evite responder com resumo generico do trabalho ou com outros itens de mesmo numero em outra secao.'
      : '',
    'Prefira explicar como um aluno iniciante deve agir agora.',
    'Baseie-se apenas no contexto enviado.',
    'Se algo nao estiver confirmado, diga explicitamente que nao foi encontrado no material.',
    'Nao use markdown pesado, tabelas ou invente detalhes.',
    context.keyFacts.length > 0 ? `Fatos-chave: ${context.keyFacts.join(' | ')}` : '',
    context.deadlineHints.length > 0 ? `Prazos detectados: ${context.deadlineHints.join(' | ')}` : '',
    context.deliverableHints.length > 0 ? `Entregaveis detectados: ${context.deliverableHints.join(' | ')}` : '',
    context.numberedHints.length > 0 ? `Trechos numerados possivelmente relevantes: ${context.numberedHints.join(' | ')}` : '',
    context.conversationSummary ? `Resumo curto da conversa recente:\n${context.conversationSummary}` : '',
    `Fontes recuperadas:\n${context.citations.map((item) => `- [${item.sourceType}] ${item.snippet}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n')
}

function normalizeAssistantAnswer(value: string) {
  return value
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizePersistedSummary(summary: string, dueText?: string) {
  const lines = summary
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean)

  const preferredOrder = ['contexto', 'objetivo', 'entregaveis', 'prazo', 'pontos de atencao', 'curso']
  const sections = new Map<string, string>()

  for (const line of lines) {
    const match = line.match(/^([^:]{3,30}):\s*(.+)$/)
    if (!match) {
      continue
    }

    const rawLabel = normalizeLabel(match[1] ?? '')
    const rawValue = match[2] ?? ''

    if (!rawLabel || !rawValue) {
      continue
    }

    if (['status', 'link de detalhe', 'modulo sugerido', 'arquivos baixados'].includes(rawLabel)) {
      continue
    }

    if (sections.has(rawLabel)) {
      continue
    }

    if (rawLabel === 'prazo') {
      sections.set(rawLabel, extractDateOnly(rawValue) || extractDateOnly(dueText) || 'Data nao identificada no material.')
      continue
    }

    sections.set(rawLabel, cleanSummaryValue(rawValue))
  }

  if (sections.size === 0) {
    return cleanSummaryValue(summary)
  }

  return preferredOrder
    .filter((label) => sections.has(label))
    .map((label) => `${capitalizeLabel(label)}: ${sections.get(label)}`)
    .join('\n')
}

function mergeMemoryWithAnswer(
  memory: TopicAgentMemory,
  question: string,
  answer: string,
  contentText: string,
  options?: {
    persistToFaq?: boolean
  },
) {
  const nextFaq =
    options?.persistToFaq === false || !isQuestionAnswerSafeForReuse(question, answer)
      ? memory.faq
      : dedupeFaq([{ question, answer }, ...memory.faq]).slice(0, 12)
  const nextSnippets = dedupeStrings([
    ...findRelevantSnippets(contentText, question, 4),
    ...memory.sourceSnippets,
  ]).slice(0, 10)

  return {
    ...memory,
    faq: nextFaq,
    keyFacts: dedupeStrings([...memory.keyFacts, ...extractBulletLikeFacts(answer)]).slice(0, 12),
    sourceSnippets: nextSnippets,
  } satisfies TopicAgentMemory
}

function parseMemoryPayload(raw: string) {
  const trimmed = raw.trim()
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fencedMatch?.[1] ?? trimmed

  try {
    const parsed = JSON.parse(candidate) as unknown
    return isTopicMemory(parsed) ? parsed : null
  } catch {
    return null
  }
}

function buildFallbackMemory(topic: SubjectTopic) {
  const snippets = findRelevantSnippets(topic.contentText, topic.title, 6)
  return {
    overview: topic.summary || buildDeterministicSummary(topic),
    deliverables: collectDeliverables(topic),
    deadlines: collectDeadlines(topic),
    faq: [],
    keyFacts: extractBulletLikeFacts(topic.summary || topic.contentText).slice(0, 8),
    answerStyle: 'Responder de forma objetiva, curta e sempre dizer quando algo nao foi encontrado.',
    fallbackPolicy: 'Se a pergunta fugir do material persistido, consultar o LLM e salvar a resposta na memoria.',
    sourceSnippets: snippets,
  } satisfies TopicAgentMemory
}

function buildAutomaticTopicLearning(topic: SubjectTopic, memory: TopicAgentMemory): TopicLearning {
  const deliverables = collectHumanDeliverables(topic, memory)
  const deadline = extractDateOnly(topic.dueText) || extractDateOnly(memory.deadlines[0]) || 'Data nao identificada no material.'
  const overview = topic.summary || memory.overview || `Atividade: ${topic.title}.`
  const gradingTips = collectPenaltyLearningTips(topic, memory)
  const firstSteps = buildLearningFirstSteps(topic, deliverables, deadline)

  return {
    frequentQuestions: [
      {
        question: 'O que preciso entregar?',
        answer: deliverables.length > 0
          ? `Voce precisa entregar: ${deliverables.join(', ')}.`
          : 'Os entregaveis nao ficaram totalmente claros no material, entao vale abrir o anexo principal para confirmar.',
      },
      {
        question: 'Qual e o prazo dessa atividade?',
        answer: deadline === 'Data nao identificada no material.'
          ? 'A data exata nao apareceu no material salvo. Abra o anexo principal e confira a data na atividade original.'
          : `A data identificada para essa atividade e ${deadline}.`,
      },
      {
        question: 'Como comeco esse trabalho?',
        answer: firstSteps.join(' '),
      },
      {
        question: 'O que pode me fazer perder pontos?',
        answer: gradingTips.length > 0
          ? `Fique atento principalmente a: ${gradingTips.join('; ')}.`
          : 'Os criterios de perda de pontos nao ficaram totalmente objetivos no material salvo, entao vale conferir o anexo principal.',
      },
    ],
    simpleConcepts: [
      {
        title: 'Como entender a atividade',
        content: overview,
      },
      {
        title: 'O que entregar na pratica',
        content: deliverables.length > 0
          ? `Pense nessa atividade como uma entrega composta por: ${deliverables.join(', ')}.`
          : 'Comece identificando os arquivos e formatos exigidos no enunciado principal.',
      },
      {
        title: 'Como resolver sem se perder',
        content: firstSteps.join(' '),
      },
      {
        title: 'Cuidados importantes',
        content: gradingTips.length > 0
          ? gradingTips.join(' ')
          : 'Revise o enunciado, confirme formato, prazo e regras da submissao antes de enviar.',
      },
    ],
    quickTips: dedupeStrings([
      deliverables.length > 0 ? `Separe cedo os arquivos pedidos: ${deliverables.join(', ')}.` : '',
      deadline === 'Data nao identificada no material.' ? 'Confirme a data no PDF principal para nao depender so do resumo.' : `Anote a data ${deadline} para nao perder o prazo.`,
      gradingTips[0] ?? '',
    ].filter(Boolean)).slice(0, 3),
  } satisfies TopicLearning
}

function buildDeterministicSummary(topic: SubjectTopic) {
  const deliverables = collectDeliverables(topic)
  return [
    `Objetivo: ${topic.title}.`,
    `Entregaveis: ${deliverables.join('; ') || 'Nao foi encontrado.'}`,
    `Prazo: ${topic.dueText || 'Nao foi encontrado.'}`,
    `Curso: ${topic.course || 'Nao identificado'}. Status: ${topic.status}.`,
    'Pontos de atencao: consulte os anexos e a screenshot da atividade para confirmar os detalhes.',
  ].join('\n')
}

function collectDeliverables(topic: SubjectTopic) {
  const fromFiles = topic.attachments.map((item) => `Arquivo "${item.name}"`)
  const fromText = findRelevantSnippets(topic.contentText, 'entrega entregavel arquivo anexar enviar', 4)
  return dedupeStrings([...fromFiles, ...fromText]).slice(0, 6)
}

function collectDeadlines(topic: SubjectTopic) {
  return dedupeStrings(
    [topic.dueText, ...findRelevantSnippets(topic.contentText, 'prazo entrega data deadline', 4)].filter(Boolean),
  ).slice(0, 4)
}

function collectHumanDeliverables(topic: SubjectTopic, memory: TopicAgentMemory) {
  const summaryMatch = topic.summary.match(/Entregaveis:\s*(.+)/i)?.[1] ?? ''
  const summaryItems = summaryMatch
    .split(/\s*;\s*|\s*,\s*|\s+ e \s+/i)
    .map((item) => normalizeLearningDeliverable(item))
    .filter(Boolean)

  const memoryItems = memory.deliverables
    .map((item) => normalizeLearningDeliverable(item))
    .filter(Boolean)

  return dedupeStrings([...summaryItems, ...memoryItems]).slice(0, 4)
}

function normalizeLearningDeliverable(value: string) {
  const cleaned = value
    .replace(/^Entregaveis:\s*/i, '')
    .replace(/^Arquivo:\s*/i, '')
    .replace(/^Arquivo\s*/i, '')
    .replace(/^Titulo:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned) {
    return ''
  }

  const lowered = cleaned.toLowerCase()
  if (/apresent/.test(lowered) && /pdf/.test(lowered)) {
    return 'apresentacao em PDF'
  }

  if (/(formular|formulario|pesquisa)/.test(lowered) && /pdf/.test(lowered)) {
    return 'formulario ou pesquisa em PDF'
  }

  if (/(base de dados|planilha|excel|xlsx)/.test(lowered)) {
    return 'base de dados em Excel'
  }

  if (/(disciplina|professor|semestre|curso|status|teams\.microsoft|checkpoint|rodolfo)/i.test(cleaned)) {
    return ''
  }

  return cleaned.length <= 48 ? cleaned : ''
}

function collectPenaltyLearningTips(topic: SubjectTopic, memory: TopicAgentMemory) {
  const candidates = [topic.summary, memory.overview, ...memory.keyFacts, topic.contentText]
    .filter(Boolean)
    .join('\n')

  const tips: string[] = []

  if (/dados fict/i.test(candidates)) {
    tips.push('nao use dados ficticios')
  }

  if (/atraso superior a 15 minutos|15 minutos ap[oó]s/i.test(candidates)) {
    tips.push('evite entregar com atraso')
  }

  if (/nota zero|aus[eê]ncia na oral|aus[eê]ncia de qualquer membro/i.test(candidates)) {
    tips.push('garanta a participacao de todos quando houver apresentacao oral')
  }

  if (/abnt|sem links/i.test(candidates)) {
    tips.push('siga formato pedido e normas do enunciado')
  }

  if (/nome completo|matr[ií]cula/i.test(candidates)) {
    tips.push('confira nome completo e matricula em todos os entregaveis')
  }

  return dedupeStrings(tips).slice(0, 4)
}

function buildLearningFirstSteps(
  topic: SubjectTopic,
  deliverables: string[],
  deadline: string,
) {
  return [
    `Primeiro, entenda o objetivo central de ${topic.title} pelo resumo do trabalho.`,
    deliverables.length > 0
      ? `Depois, monte uma checklist com ${deliverables.join(', ')}.`
      : 'Depois, abra o anexo principal e anote os entregaveis e formatos exigidos.',
    deadline === 'Data nao identificada no material.'
      ? 'Por fim, confirme manualmente a data no PDF principal antes de enviar.'
      : `Por fim, organize a execucao para concluir tudo antes de ${deadline}.`,
  ]
}

function findRelevantSnippets(content: string, question: string, limit = 3) {
  const tokens = tokenize(question)
  const chunks = content
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 20)

  return chunks
    .map((chunk) => ({
      chunk,
      score: tokens.reduce((score, token) => (chunk.toLowerCase().includes(token) ? score + 1 : score), 0),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.chunk.slice(0, 320))
}

function computeSimilarity(source: string, question: string) {
  const sourceTokens = new Set(tokenize(source))
  const questionTokens = tokenize(question)

  if (questionTokens.length === 0) {
    return 0
  }

  let hits = 0
  for (const token of questionTokens) {
    if (sourceTokens.has(token)) {
      hits += 1
    }
  }

  return hits / questionTokens.length
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

function extractBulletLikeFacts(value: string) {
  return value
    .split(/\n+/)
    .map((item) => item.trim().replace(/^[-*]\s*/, ''))
    .filter((item) => item.length >= 12)
}

function normalizeLabel(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

function cleanSummaryValue(value: string) {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^Prazo de entrega às?\s*/i, '')
    .replace(/^Prazo de entrega\s*/i, '')
    .trim()
}

function extractDateOnly(value: string | undefined) {
  const source = value?.trim()
  if (!source) {
    return ''
  }

  const numeric = source.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/)
  if (!numeric) {
    return ''
  }

  const [, day, month, year] = numeric
  const fullYear = year!.length === 2 ? `20${year}` : year!
  return `${day!.padStart(2, '0')}/${month!.padStart(2, '0')}/${fullYear}`
}

function capitalizeLabel(value: string) {
  if (value === 'pontos de atencao') {
    return 'Pontos de atencao'
  }

  if (value === 'entregaveis') {
    return 'Entregaveis'
  }

  return value.charAt(0).toUpperCase() + value.slice(1)
}

function dedupeStrings(values: string[]) {
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

function dedupeFaq(items: TopicFaqItem[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.question}::${item.answer}`.trim()
    if (!key || seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}

function sanitizeTopicMemory(memory: TopicAgentMemory) {
  return {
    ...memory,
    faq: dedupeFaq(
      memory.faq.filter((item) => isUsefulQuestion(item.question) && isQuestionAnswerSafeForReuse(item.question, item.answer)),
    ).slice(0, 10),
    deliverables: dedupeStrings(memory.deliverables.filter((item) => item.trim().length >= 12)).slice(0, 6),
    deadlines: dedupeStrings(memory.deadlines.filter((item) => item.trim().length >= 8)).slice(0, 6),
    keyFacts: dedupeStrings(
      memory.keyFacts.filter(
        (item) =>
          item.trim().length >= 12 &&
          !/\b(nao encontrei|não encontrei|nenhuma referencia|nenhuma referência)\b/i.test(item),
      ),
    ).slice(0, 10),
    sourceSnippets: dedupeStrings(memory.sourceSnippets.filter((item) => item.trim().length >= 20)).slice(0, 8),
  } satisfies TopicAgentMemory
}

function isUsefulQuestion(question: string) {
  const normalized = question.trim().toLowerCase()
  if (!normalized) {
    return false
  }

  return !/^(oi|ola|olá|ae|aee|teste|blz|ok)+$/.test(normalized)
}

function isQuestionAnswerSafeForReuse(question: string, answer: string) {
  if (!isUsefulQuestion(question)) {
    return false
  }

  const trimmedAnswer = answer.trim()
  if (trimmedAnswer.length < 30) {
    return false
  }

  if (/\b(nao encontrei|não encontrei|nenhuma referencia|nenhuma referência)\b/i.test(trimmedAnswer)) {
    return false
  }

  return true
}

function contentLooksThin(content: string) {
  return content.length < 1200 || /Avisos de ingestao: upload_failed/i.test(content)
}

async function recoverTopicContentFromDebugHistory(topicId: string) {
  const events = await readLlmDebugHistory(200, topicId)
  for (const event of events) {
    if (event.endpoint !== '/api/upload' || event.statusCode !== 200 || !event.response || typeof event.response !== 'object') {
      continue
    }

    const response = event.response as { documents?: Array<{ name?: unknown; content?: unknown }> }
    const documents = Array.isArray(response.documents) ? response.documents : []
    const recoveredText = documents
      .map((item) => {
        const name = typeof item.name === 'string' ? item.name : 'attachment'
        const content = typeof item.content === 'string' ? item.content : ''
        return content ? `Arquivo: ${name}\n${content}` : ''
      })
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 60000)

    if (recoveredText.length >= 800) {
      return recoveredText
    }
  }

  return null
}

function chooseBestContentResult(
  previous: SubjectTopic | undefined,
  nextResult: {
    contentText: string
    warnings: string[]
  },
) {
  if (!previous) {
    return nextResult
  }

  if (scoreContentRichness(previous.contentText) > scoreContentRichness(nextResult.contentText)) {
    return {
      contentText: previous.contentText,
      warnings: dedupeStrings([...previous.warnings, ...nextResult.warnings]),
    }
  }

  return nextResult
}

function scoreContentRichness(content: string) {
  const numberedItems = (content.match(/\b\d+\)/g) ?? []).length
  const paragraphs = content.split(/\n{2,}/).filter((item) => item.trim().length >= 30).length
  return content.length + numberedItems * 400 + paragraphs * 80
}

function dedupePaths(values: string[]) {
  return dedupeStrings(values.map((item) => path.resolve(item)))
}

function isTopicMemory(value: unknown): value is TopicAgentMemory {
  if (!value || typeof value !== 'object') {
    return false
  }

  const item = value as Partial<TopicAgentMemory>
  return (
    typeof item.overview === 'string' &&
    Array.isArray(item.deliverables) &&
    Array.isArray(item.deadlines) &&
    Array.isArray(item.faq) &&
    Array.isArray(item.keyFacts) &&
    typeof item.answerStyle === 'string' &&
    typeof item.fallbackPolicy === 'string' &&
    Array.isArray(item.sourceSnippets)
  )
}

function isTopicLearning(value: unknown): value is TopicLearning {
  if (!value || typeof value !== 'object') {
    return false
  }

  const item = value as Partial<TopicLearning>
  return (
    Array.isArray(item.frequentQuestions) &&
    Array.isArray(item.simpleConcepts) &&
    Array.isArray(item.quickTips)
  )
}

function getTopicDir(topicId: string) {
  return path.join(botConfig.subjectsDir, topicId)
}

function guessMimeType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase()

  if (extension === '.png') {
    return 'image/png'
  }

  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpeg'
  }

  if (extension === '.webp') {
    return 'image/webp'
  }

  return 'application/octet-stream'
}

function buildSourceSignature(assignment: AssignmentItem) {
  return JSON.stringify({
    title: assignment.title,
    dueText: assignment.dueText,
    course: assignment.course,
    status: assignment.status,
    detailUrl: assignment.detailUrl,
    downloadedFiles: dedupePaths(assignment.downloadedFiles.filter(Boolean)),
    screenshotFiles: dedupePaths((assignment.screenshotFiles ?? []).filter(Boolean)),
    capturedAt: assignment.capturedAt,
  })
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function detectModuleKey(assignment: AssignmentItem | undefined) {
  if (!assignment) {
    return 'geral'
  }

  const source = [
    assignment.title,
    assignment.course,
    assignment.dueText,
    assignment.downloadedFiles.map((item) => path.basename(item)).join(' '),
  ]
    .join(' ')
    .toLowerCase()

  if (/\bapi\b|backend|node|server|banco|sql/.test(source)) {
    return 'backend'
  }

  if (/python|\.py\b|algoritmo|lista|for|while|matriz|input/.test(source)) {
    return 'backend'
  }

  if (/security|cloud|nuvem|framework/.test(source)) {
    return 'cloud-security'
  }

  if (/prompt|rag|modelo|llm|ia|inteligencia artificial/.test(source)) {
    return 'ia-aplicada'
  }

  if (/scrum|agil|kanban|projeto/.test(source)) {
    return 'gestao-agil'
  }

  if (/frontend|react|css|html|vite|interface/.test(source)) {
    return 'frontend'
  }

  if (/fundamentos|introducao|conceito|logica/.test(source)) {
    return 'fundamentos'
  }

  return 'geral'
}

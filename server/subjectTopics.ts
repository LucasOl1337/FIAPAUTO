import fs from 'node:fs/promises'
import path from 'node:path'
import { botConfig } from '../bot/src/config.ts'
import type { AssignmentItem } from '../bot/src/types.ts'
import { ensureDir, readJsonFile, writeJsonFile } from '../bot/src/utils/fs.ts'
import { readLlmDebugHistory } from './llmDebugStore.ts'
import {
  llmConfig,
  postLlmChat,
  uploadFilesToLlm,
  type LlmDocument,
  type LlmImage,
} from './llmClient.ts'

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
    const contentResult =
      previous && previous.sourceSignature === sourceSignature
        ? {
            contentText: previous.contentText,
            warnings: previous.warnings,
          }
        : await buildTopicContentSafely(topicId, assignment)

    await writeTopicContent(topicId, contentResult.contentText)

    const summaryState = await readStoredSummary(topicId)
    const memoryState = await readStoredMemory(topicId)
    const topic: SubjectTopic = {
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
      summary: summaryState.summary ?? previous?.summary ?? '',
      summaryGeneratedAt: summaryState.generatedAt ?? previous?.summaryGeneratedAt,
      agentMemory: memoryState.memory ?? previous?.agentMemory ?? null,
      agentMemoryGeneratedAt: memoryState.generatedAt ?? previous?.agentMemoryGeneratedAt,
      lastAskedAt: previous?.lastAskedAt,
      updatedAt:
        previous && previous.sourceSignature === sourceSignature
          ? previous.updatedAt
          : new Date().toISOString(),
      warnings: contentResult.warnings,
      sourceSignature,
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
  const summary = response.content.trim() || buildDeterministicSummary(topic)

  await writeSummaryFile(topic.id, {
    summary,
    generatedAt,
  })

  await updateTopicRecord(topic.id, (current) => ({
    ...current,
    summary,
    summaryGeneratedAt: generatedAt,
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

  if (topic.agentMemory && topic.agentMemoryGeneratedAt && !force) {
    return topic.agentMemory
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

  await writeMemoryFile(topicId, {
    memory,
    generatedAt,
  })

  await updateTopicRecord(topicId, (current) => ({
    ...current,
    agentMemory: memory,
    agentMemoryGeneratedAt: generatedAt,
    updatedAt: generatedAt,
  }))

  return memory
}

export async function askTopic(input: { topicId: string; question: string }) {
  const topic = await getTopicById(input.topicId)
  const memory = await generateTopicMemory(topic.id, false)
  const localAnswer = answerFromLocalMemory(topic, memory, input.question)
  const answeredAt = new Date().toISOString()

  if (localAnswer.confidence >= 0.72) {
    await updateTopicRecord(topic.id, (current) => ({
      ...current,
      lastAskedAt: answeredAt,
      updatedAt: answeredAt,
    }))

    return {
      topicId: topic.id,
      answer: localAnswer.answer,
      moduleKey: topic.moduleKey,
      warnings: topic.warnings,
      usedFallback: false,
      answeredAt,
    } satisfies TopicAskResult
  }

  const response = await postLlmChat({
    jobId: `topic-ask-${topic.id}-${Date.now()}`,
    topicId: topic.id,
    mode: 'default',
    message: [
      `Pergunta do usuario: ${input.question}`,
      'Responda em portugues do Brasil, em no maximo 6 linhas.',
      'Baseie-se apenas no contexto do topico.',
      'Se faltar informacao, diga explicitamente o que nao foi encontrado.',
      'Nao use markdown.',
    ].join('\n'),
    documents: buildTopicDocuments(topic, memory),
    images: await buildTopicImages(topic),
  })

  const answer = response.content.trim() || localAnswer.answer
  const updatedMemory = mergeMemoryWithAnswer(memory, input.question, answer, topic.contentText)

  await writeMemoryFile(topic.id, {
    memory: updatedMemory,
    generatedAt: answeredAt,
  })

  await updateTopicRecord(topic.id, (current) => ({
    ...current,
    agentMemory: updatedMemory,
    agentMemoryGeneratedAt: answeredAt,
    lastAskedAt: answeredAt,
    updatedAt: answeredAt,
  }))

  return {
    topicId: topic.id,
    answer,
    moduleKey: topic.moduleKey,
    warnings: topic.warnings,
    usedFallback: true,
    answeredAt,
  } satisfies TopicAskResult
}

export async function getTopicDebug(topicId: string) {
  const topic = await getTopicById(topicId)
  return {
    topic,
    events: await readLlmDebugHistory(100, topicId),
    llm: llmConfig(),
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

async function writeSummaryFile(topicId: string, value: { summary: string; generatedAt: string }) {
  await writeJsonFile(path.join(getTopicDir(topicId), 'summary.json'), value)
}

async function writeMemoryFile(topicId: string, value: { memory: TopicAgentMemory; generatedAt: string }) {
  await writeJsonFile(path.join(getTopicDir(topicId), 'memory.json'), value)
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
    return await buildTopicContentText(topicId, assignment)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'content_ingestion_failed'
    return {
      contentText: [
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

  const faqMatch = memory.faq.find((item) => computeSimilarity(`${item.question} ${item.answer}`, question) >= 0.75)
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

function mergeMemoryWithAnswer(
  memory: TopicAgentMemory,
  question: string,
  answer: string,
  contentText: string,
) {
  const nextFaq = dedupeFaq([{ question, answer }, ...memory.faq]).slice(0, 12)
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
    .filter((item) => item.length >= 3)
}

function extractBulletLikeFacts(value: string) {
  return value
    .split(/\n+/)
    .map((item) => item.trim().replace(/^[-*]\s*/, ''))
    .filter((item) => item.length >= 12)
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

import fs from 'node:fs/promises'
import path from 'node:path'
import { botConfig } from '@fiapauto/bots'
import type { LibraryMatch, LibrarySourceType, ValidatedAnswerEntry } from '../apis/contracts/index.ts'
import { ensureDir, readJsonFile, writeJsonFile } from '../database/fs.ts'
import { syncTopicsFromAssignments, type SubjectTopic } from './subjectTopics.ts'

export type KnowledgeChunk = {
  id: string
  topicId: string
  moduleKey: string
  sourceType: 'summary' | 'overview' | 'deliverable' | 'deadline' | 'faq' | 'content'
  sourcePath: string
  text: string
  tokens: string[]
  keywords: string[]
  entities: string[]
  capturedAt: string
}

export type KnowledgeTopicRef = {
  id: string
  title: string
  moduleKey: string
  course: string
  summary: string
  updatedAt: string
}

export type KnowledgeModuleRef = {
  moduleKey: string
  topicIds: string[]
  topicCount: number
  keywords: string[]
  faqCount: number
  updatedAt: string
}

export type KnowledgeConcept = {
  id: string
  label: string
  occurrences: number
  moduleKeys: string[]
  topicIds: string[]
}

export type KnowledgeFaqEntry = {
  id: string
  question: string
  answer: string
  topicIds: string[]
  moduleKeys: string[]
  updatedAt: string
}

export type KnowledgeRelation = {
  fromType: 'topic' | 'module' | 'concept'
  fromId: string
  toType: 'topic' | 'module' | 'concept'
  toId: string
  kind: 'belongs_to' | 'mentions' | 'shares_concept'
}

export type KnowledgeWarehouse = {
  generatedAt: string
  topicCount: number
  chunkCount: number
  moduleCount: number
  conceptCount: number
  faqCount: number
  libraryCount: number
  validatedAnswerCount: number
  learningPatternCount: number
  topics: KnowledgeTopicRef[]
  modules: KnowledgeModuleRef[]
  concepts: KnowledgeConcept[]
  faqGlobal: KnowledgeFaqEntry[]
  relations: KnowledgeRelation[]
  library: KnowledgeLibraryEntry[]
}

export type KnowledgeSearchResult = {
  chunk: KnowledgeChunk
  score: number
}

export type KnowledgeLibraryEntry = {
  id: string
  sourceType: LibrarySourceType
  topicId: string
  topicTitle: string
  moduleKey: string
  text: string
  question?: string
  citationsCount: number
  groundingScore: number
  sourceSignature: string
  createdAt: string
  tokens: string[]
  keywords: string[]
}

export type KnowledgeLibrarySearchResult = {
  entry: KnowledgeLibraryEntry
  score: number
  reason: string
}

const validatedAnswersFile = path.join(botConfig.knowledgeCatalogDir, 'validated-answers.json')

const stopwords = new Set([
  'a', 'ao', 'aos', 'as', 'com', 'como', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'entre',
  'essa', 'esse', 'esta', 'este', 'foi', 'ha', 'na', 'nas', 'no', 'nos', 'o', 'os', 'ou',
  'para', 'por', 'prazo', 'que', 'se', 'sem', 'ser', 'sua', 'suas', 'tema', 'um', 'uma',
  'você', 'voce',
])

export async function rebuildKnowledgeWarehouse() {
  await ensureDir(botConfig.knowledgeCatalogDir)
  await ensureDir(botConfig.knowledgeIndexDir)

  const topics = await syncTopicsFromAssignments()
  const chunks = topics.flatMap((topic) => buildChunksForTopic(topic))
  const validatedAnswers = await readValidatedAnswers()
  const generatedAt = new Date().toISOString()
  const topicRefs = topics.map((topic) => ({
    id: topic.id,
    title: topic.title,
    moduleKey: topic.moduleKey,
    course: topic.course,
    summary: topic.summary,
    updatedAt: topic.updatedAt,
  })) satisfies KnowledgeTopicRef[]

  const modules = buildModules(topics, chunks, generatedAt)
  const concepts = buildConcepts(chunks)
  const faqGlobal = buildGlobalFaq(topics, generatedAt)
  const relations = buildRelations(topicRefs, modules, concepts)
  const invertedIndex = buildInvertedIndex(chunks)
  const entityMap = buildEntityMap(chunks)
  const library = buildLibraryEntries(topics, chunks, validatedAnswers)

  const warehouse: KnowledgeWarehouse = {
    generatedAt,
    topicCount: topicRefs.length,
    chunkCount: chunks.length,
    moduleCount: modules.length,
    conceptCount: concepts.length,
    faqCount: faqGlobal.length,
    libraryCount: library.length,
    validatedAnswerCount: validatedAnswers.length,
    learningPatternCount: library.filter((entry) => entry.sourceType === 'learning_pattern').length,
    topics: topicRefs,
    modules,
    concepts,
    faqGlobal,
    relations,
    library,
  }

  await writeJsonFile(botConfig.knowledgeWarehouseFile, warehouse)
  await writeJsonFile(path.join(botConfig.knowledgeCatalogDir, 'topics.json'), topicRefs)
  await writeJsonFile(path.join(botConfig.knowledgeCatalogDir, 'modules.json'), modules)
  await writeJsonFile(path.join(botConfig.knowledgeCatalogDir, 'concepts.json'), concepts)
  await writeJsonFile(path.join(botConfig.knowledgeCatalogDir, 'faq-global.json'), faqGlobal)
  await writeJsonFile(validatedAnswersFile, validatedAnswers)
  await writeJsonFile(path.join(botConfig.knowledgeCatalogDir, 'library.json'), library)
  await writeJsonFile(path.join(botConfig.knowledgeIndexDir, 'inverted-index.json'), invertedIndex)
  await writeJsonFile(path.join(botConfig.knowledgeIndexDir, 'entity-map.json'), entityMap)
  await writeJsonFile(path.join(botConfig.knowledgeIndexDir, 'relations.json'), relations)
  await writeChunksJsonl(chunks)

  return warehouse
}

export async function getKnowledgeWarehouse() {
  return readJsonFile<KnowledgeWarehouse | null>(botConfig.knowledgeWarehouseFile, null)
}

export async function ensureKnowledgeWarehouse() {
  const warehouse = await getKnowledgeWarehouse()
  if (warehouse && Array.isArray(warehouse.library)) {
    return warehouse
  }

  return rebuildKnowledgeWarehouse()
}

export async function readKnowledgeChunks() {
  const chunksFile = path.join(botConfig.knowledgeIndexDir, 'chunks.jsonl')

  try {
    const raw = await fs.readFile(chunksFile, 'utf-8')
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as KnowledgeChunk)
  } catch {
    return []
  }
}

export async function readValidatedAnswers() {
  return readJsonFile<ValidatedAnswerEntry[]>(validatedAnswersFile, [])
}

export async function listValidatedAnswerEntries(topicId?: string) {
  const entries = await readValidatedAnswers()
  return topicId ? entries.filter((entry) => entry.topicId === topicId) : entries
}

export async function saveValidatedAnswerEntry(entry: ValidatedAnswerEntry) {
  await ensureDir(botConfig.knowledgeCatalogDir)
  const currentEntries = await readValidatedAnswers()
  const nextEntries = dedupeValidatedAnswers([entry, ...currentEntries]).slice(0, 400)
  await writeJsonFile(validatedAnswersFile, nextEntries)
  return entry
}

export async function searchKnowledgeChunks(input: {
  query: string
  topicId?: string
  moduleKey?: string
  preferredSourceTypes?: KnowledgeChunk['sourceType'][]
  limit?: number
}) {
  const chunks = await readKnowledgeChunks()
  const tokens = tokenize(input.query)
  const preferredSourceTypes = new Set(input.preferredSourceTypes ?? [])
  const limit = Math.max(1, Math.min(input.limit ?? 6, 20))

  return chunks
    .filter((chunk) => {
      if (input.topicId && chunk.topicId !== input.topicId) {
        return false
      }

      if (input.moduleKey && chunk.moduleKey !== input.moduleKey) {
        return false
      }

      return true
    })
    .map((chunk) => ({
      chunk,
      score: scoreChunk(chunk, tokens, preferredSourceTypes),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export async function searchKnowledgeLibrary(input: {
  query: string
  currentTopicId: string
  currentTopicTitle: string
  currentModuleKey: string
  currentDeliverables?: string[]
  intent?: string
  limit?: number
}) {
  const warehouse = await ensureKnowledgeWarehouse()
  const tokens = tokenize(input.query)
  const titleTokens = tokenize(input.currentTopicTitle)
  const deliverableTokens = tokenize((input.currentDeliverables ?? []).join(' '))
  const limit = Math.max(1, Math.min(input.limit ?? 6, 12))

  return (warehouse.library ?? [])
    .filter((entry) => entry.topicId !== input.currentTopicId)
    .map((entry) => {
      const { score, reasons } = scoreLibraryEntry(entry, {
        tokens,
        titleTokens,
        deliverableTokens,
        currentModuleKey: input.currentModuleKey,
        intent: input.intent ?? 'unknown',
      })

      return {
        entry,
        score,
        reason: reasons.join('; '),
      } satisfies KnowledgeLibrarySearchResult
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

function buildChunksForTopic(topic: SubjectTopic) {
  const capturedAt = topic.updatedAt
  const chunks: KnowledgeChunk[] = []
  const basePath = path.join(botConfig.knowledgeIndexDir, 'chunks.jsonl')

  if (topic.summary) {
    chunks.push(createChunk(topic, 'summary', basePath, topic.summary, capturedAt))
  }

  if (topic.agentMemory?.overview) {
    chunks.push(createChunk(topic, 'overview', basePath, topic.agentMemory.overview, capturedAt))
  }

  for (const deliverable of topic.agentMemory?.deliverables ?? []) {
    chunks.push(createChunk(topic, 'deliverable', basePath, deliverable, capturedAt))
  }

  for (const faq of topic.agentMemory?.faq ?? []) {
    chunks.push(
      createChunk(
        topic,
        'faq',
        basePath,
        `Pergunta: ${faq.question}\nResposta: ${faq.answer}`,
        capturedAt,
      ),
    )
  }

  const paragraphs = topic.contentText
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 30)
    .slice(0, 40)

  for (const paragraph of paragraphs) {
    chunks.push(createChunk(topic, 'content', basePath, paragraph, capturedAt))
  }

  return dedupeChunkList(chunks)
}

function createChunk(
  topic: SubjectTopic,
  sourceType: KnowledgeChunk['sourceType'],
  sourcePath: string,
  text: string,
  capturedAt: string,
) {
  const tokens = tokenize(text)
  return {
    id: `${topic.id}:${sourceType}:${hashText(text)}`,
    topicId: topic.id,
    moduleKey: topic.moduleKey,
    sourceType,
    sourcePath,
    text: text.slice(0, 1200),
    tokens,
    keywords: extractKeywords(tokens),
    entities: extractEntities(text),
    capturedAt,
  } satisfies KnowledgeChunk
}

function buildModules(topics: SubjectTopic[], chunks: KnowledgeChunk[], generatedAt: string) {
  const moduleMap = new Map<string, KnowledgeModuleRef>()

  for (const topic of topics) {
    const existing = moduleMap.get(topic.moduleKey)
    if (existing) {
      existing.topicIds.push(topic.id)
      continue
    }

    moduleMap.set(topic.moduleKey, {
      moduleKey: topic.moduleKey,
      topicIds: [topic.id],
      topicCount: 0,
      keywords: [],
      faqCount: 0,
      updatedAt: generatedAt,
    })
  }

  for (const moduleItem of moduleMap.values()) {
    const moduleChunks = chunks.filter((chunk) => chunk.moduleKey === moduleItem.moduleKey)
    moduleItem.topicIds = dedupeStrings(moduleItem.topicIds)
    moduleItem.topicCount = moduleItem.topicIds.length
    moduleItem.keywords = topKeywords(moduleChunks.flatMap((chunk) => chunk.keywords), 10)
    moduleItem.faqCount = moduleChunks.filter((chunk) => chunk.sourceType === 'faq').length
  }

  return Array.from(moduleMap.values()).sort((a, b) => a.moduleKey.localeCompare(b.moduleKey))
}

function buildConcepts(chunks: KnowledgeChunk[]) {
  const conceptMap = new Map<string, KnowledgeConcept>()

  for (const chunk of chunks) {
    for (const keyword of chunk.keywords) {
      const existing = conceptMap.get(keyword)

      if (existing) {
        existing.occurrences += 1
        existing.moduleKeys = dedupeStrings([...existing.moduleKeys, chunk.moduleKey])
        existing.topicIds = dedupeStrings([...existing.topicIds, chunk.topicId])
        continue
      }

      conceptMap.set(keyword, {
        id: `concept:${keyword}`,
        label: keyword,
        occurrences: 1,
        moduleKeys: [chunk.moduleKey],
        topicIds: [chunk.topicId],
      })
    }
  }

  return Array.from(conceptMap.values())
    .filter((item) => item.occurrences >= 2)
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, 80)
}

function buildGlobalFaq(topics: SubjectTopic[], generatedAt: string) {
  const faqMap = new Map<string, KnowledgeFaqEntry>()

  for (const topic of topics) {
    for (const faq of topic.agentMemory?.faq ?? []) {
      const key = faq.question.trim().toLowerCase()
      const existing = faqMap.get(key)

      if (existing) {
        existing.topicIds = dedupeStrings([...existing.topicIds, topic.id])
        existing.moduleKeys = dedupeStrings([...existing.moduleKeys, topic.moduleKey])
        continue
      }

      faqMap.set(key, {
        id: `faq:${hashText(`${faq.question}:${faq.answer}`)}`,
        question: faq.question,
        answer: faq.answer,
        topicIds: [topic.id],
        moduleKeys: [topic.moduleKey],
        updatedAt: generatedAt,
      })
    }
  }

  return Array.from(faqMap.values())
}

function buildRelations(
  topics: KnowledgeTopicRef[],
  modules: KnowledgeModuleRef[],
  concepts: KnowledgeConcept[],
) {
  const relations: KnowledgeRelation[] = []

  for (const topic of topics) {
    relations.push({
      fromType: 'topic',
      fromId: topic.id,
      toType: 'module',
      toId: topic.moduleKey,
      kind: 'belongs_to',
    })
  }

  for (const concept of concepts) {
    for (const topicId of concept.topicIds) {
      relations.push({
        fromType: 'topic',
        fromId: topicId,
        toType: 'concept',
        toId: concept.id,
        kind: 'mentions',
      })
    }
  }

  for (const moduleItem of modules) {
    for (const concept of concepts.filter((item) => item.moduleKeys.includes(moduleItem.moduleKey)).slice(0, 8)) {
      relations.push({
        fromType: 'module',
        fromId: moduleItem.moduleKey,
        toType: 'concept',
        toId: concept.id,
        kind: 'shares_concept',
      })
    }
  }

  return relations
}

function buildInvertedIndex(chunks: KnowledgeChunk[]) {
  const index = new Map<string, string[]>()

  for (const chunk of chunks) {
    for (const token of chunk.tokens) {
      const existing = index.get(token) ?? []
      existing.push(chunk.id)
      index.set(token, dedupeStrings(existing))
    }
  }

  return Object.fromEntries(index.entries())
}

function buildEntityMap(chunks: KnowledgeChunk[]) {
  const map = new Map<string, string[]>()

  for (const chunk of chunks) {
    for (const entity of chunk.entities) {
      const existing = map.get(entity) ?? []
      existing.push(chunk.id)
      map.set(entity, dedupeStrings(existing))
    }
  }

  return Object.fromEntries(map.entries())
}

function buildLibraryEntries(
  topics: SubjectTopic[],
  chunks: KnowledgeChunk[],
  validatedAnswers: ValidatedAnswerEntry[],
) {
  const topicById = new Map(topics.map((topic) => [topic.id, topic]))
  const officialEntries = chunks
    .filter((chunk) => isLibraryWorthyChunk(chunk))
    .map((chunk) => {
      const topic = topicById.get(chunk.topicId)
      return {
        id: `library:${chunk.id}`,
        sourceType: 'official_chunk',
        topicId: chunk.topicId,
        topicTitle: topic?.title ?? chunk.topicId,
        moduleKey: chunk.moduleKey,
        text: chunk.text,
        citationsCount: 1,
        groundingScore: 1,
        sourceSignature: topic?.sourceSignature ?? '',
        createdAt: chunk.capturedAt,
        tokens: chunk.tokens,
        keywords: chunk.keywords,
      } satisfies KnowledgeLibraryEntry
    })

  const learningPatternEntries = topics.flatMap((topic) =>
    (topic.learning?.learningTopics ?? []).map((item) => {
      const text = [
        item.title,
        item.explanation,
        `Dificuldade comum: ${item.commonDifficulty}`,
        `Estrategia: ${item.studyStrategy}`,
      ]
        .filter(Boolean)
        .join(' ')

      return {
        id: `learning:${topic.id}:${hashText(text)}`,
        sourceType: 'learning_pattern',
        topicId: topic.id,
        topicTitle: topic.title,
        moduleKey: topic.moduleKey,
        text,
        citationsCount: 0,
        groundingScore: 0.72,
        sourceSignature: topic.sourceSignature,
        createdAt: topic.learningGeneratedAt ?? topic.updatedAt,
        tokens: tokenize(text),
        keywords: extractKeywords(tokenize(text)),
      } satisfies KnowledgeLibraryEntry
    }),
  )

  const validatedAnswerEntries = validatedAnswers
    .filter((entry) => {
      const sourceTopic = topicById.get(entry.topicId)
      return sourceTopic?.sourceSignature === entry.sourceSignature
    })
    .map((entry) => ({
      id: entry.id,
      sourceType: 'validated_answer',
      topicId: entry.topicId,
      topicTitle: entry.topicTitle,
      moduleKey: entry.moduleKey,
      text: entry.answer,
      question: entry.question,
      citationsCount: entry.citations.length,
      groundingScore: entry.groundingScore,
      sourceSignature: entry.sourceSignature,
      createdAt: entry.createdAt,
      tokens: tokenize(`${entry.question} ${entry.answer}`),
      keywords: extractKeywords(tokenize(`${entry.question} ${entry.answer}`)),
    }) satisfies KnowledgeLibraryEntry)

  return dedupeLibraryEntries([
    ...officialEntries,
    ...learningPatternEntries,
    ...validatedAnswerEntries,
  ])
}

function isLibraryWorthyChunk(chunk: KnowledgeChunk) {
  if (chunk.sourceType === 'content' && chunk.text.length < 80) {
    return false
  }

  return !/\b(status|link de detalhe|arquivos baixados|modulo sugerido)\b/i.test(chunk.text)
}

async function writeChunksJsonl(chunks: KnowledgeChunk[]) {
  const chunksFile = path.join(botConfig.knowledgeIndexDir, 'chunks.jsonl')
  const content = chunks.map((chunk) => JSON.stringify(chunk)).join('\n')
  await fs.writeFile(chunksFile, content ? `${content}\n` : '', 'utf-8')
}

function scoreLibraryEntry(
  entry: KnowledgeLibraryEntry,
  input: {
    tokens: string[]
    titleTokens: string[]
    deliverableTokens: string[]
    currentModuleKey: string
    intent: string
  },
) {
  let score = 0
  const reasons: string[] = []

  for (const token of input.tokens) {
    if (entry.tokens.includes(token)) {
      score += 2
      reasons.push(`token:${token}`)
    } else if (entry.text.toLowerCase().includes(token)) {
      score += 1
    }
  }

  const titleOverlap = input.titleTokens.filter((token) => entry.tokens.includes(token)).length
  const deliverableOverlap = input.deliverableTokens.filter((token) => entry.tokens.includes(token)).length
  if (entry.moduleKey === input.currentModuleKey) {
    score += 2
    reasons.push('mesmo_modulo')
  }

  if (titleOverlap > 0) {
    score += Math.min(titleOverlap, 3)
    reasons.push('titulo_parecido')
  }

  if (deliverableOverlap > 0) {
    score += Math.min(deliverableOverlap, 2)
    reasons.push('entregaveis_parecidos')
  }

  if (entry.sourceType === 'official_chunk') {
    score += input.intent === 'deliverable' || input.intent === 'grading' ? 3 : 1
    reasons.push('fonte_oficial')
  }

  if (entry.sourceType === 'learning_pattern') {
    score += input.intent === 'explanation' || input.intent === 'next_steps' || input.intent === 'unknown' ? 3 : 1
    reasons.push('padrao_didatico')
  }

  if (entry.sourceType === 'validated_answer') {
    score += 2 + Math.round(entry.groundingScore * 3)
    if (entry.citationsCount > 0) {
      score += 2
      reasons.push('resposta_validada')
    }
  }

  const entryAgeDays = Math.max(0, Math.floor((Date.now() - Date.parse(entry.createdAt || '')) / 86400000))
  if (entryAgeDays > 180) {
    score -= 2
    reasons.push('penalidade_antiguidade')
  }

  if (entry.citationsCount === 0 && entry.sourceType === 'validated_answer') {
    score -= 3
    reasons.push('penalidade_sem_citacoes')
  }

  if (/\b(nao encontrei|nenhuma referencia|nenhum dado)\b/i.test(entry.text)) {
    score -= 4
    reasons.push('penalidade_generica')
  }

  return { score, reasons }
}

function scoreChunk(
  chunk: KnowledgeChunk,
  tokens: string[],
  preferredSourceTypes: Set<KnowledgeChunk['sourceType']>,
) {
  let score = 0

  for (const token of tokens) {
    if (chunk.tokens.includes(token)) {
      score += 2
    }

    if (chunk.text.toLowerCase().includes(token)) {
      score += 1
    }
  }

  if (preferredSourceTypes.has(chunk.sourceType)) {
    score += 2
  }

  if (chunk.sourceType === 'faq') {
    score += 1
  }

  return score
}

function tokenize(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/i)
    .map((item) => item.trim())
    .filter((item) => (item.length >= 3 || /^\d+$/.test(item)) && !stopwords.has(item))
}

function extractKeywords(tokens: string[]) {
  return topKeywords(tokens, 8)
}

function topKeywords(tokens: string[], limit: number) {
  const counts = new Map<string, number>()

  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([token]) => token)
}

function extractEntities(text: string) {
  const entities = new Set<string>()

  for (const dateMatch of text.match(/\b\d{2}\/\d{2}\/\d{4}\b/g) ?? []) {
    entities.add(dateMatch)
  }

  for (const fileMatch of text.match(/\b[\w(). -]+\.(pdf|py|js|ts|docx|xlsx|r)\b/gi) ?? []) {
    entities.add(fileMatch.trim())
  }

  return Array.from(entities).slice(0, 10)
}

function dedupeChunkList(chunks: KnowledgeChunk[]) {
  const seen = new Set<string>()
  return chunks.filter((chunk) => {
    const key = `${chunk.topicId}:${chunk.sourceType}:${chunk.text}`
    if (seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}

function dedupeLibraryEntries(entries: KnowledgeLibraryEntry[]) {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = `${entry.sourceType}:${entry.topicId}:${normalizeText(entry.question || '')}:${normalizeText(entry.text)}`
    if (!key || seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}

function dedupeStrings(values: string[]) {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = value.trim()
    if (!key || seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}

function dedupeValidatedAnswers(entries: ValidatedAnswerEntry[]) {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = `${entry.topicId}:${normalizeText(entry.question)}:${normalizeText(entry.answer)}`
    if (!key || seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function toLibraryMatch(result: KnowledgeLibrarySearchResult, usedInAnswer: boolean, reason: string): LibraryMatch {
  return {
    id: result.entry.id,
    sourceType: result.entry.sourceType,
    topicId: result.entry.topicId,
    topicTitle: result.entry.topicTitle,
    moduleKey: result.entry.moduleKey,
    score: Number(result.score.toFixed(2)),
    confidence: result.score >= 11 ? 'high' : result.score >= 7 ? 'medium' : 'low',
    usedInAnswer,
    reason,
    snippet: result.entry.text.slice(0, 240),
    question: result.entry.question,
    citationsCount: result.entry.citationsCount,
    createdAt: result.entry.createdAt,
  }
}

function hashText(text: string) {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0
  }
  return hash.toString(16)
}

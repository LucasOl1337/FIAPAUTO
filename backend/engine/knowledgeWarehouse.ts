import fs from 'node:fs/promises'
import path from 'node:path'
import { botConfig } from '@fiapauto/bots'
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
  topics: KnowledgeTopicRef[]
  modules: KnowledgeModuleRef[]
  concepts: KnowledgeConcept[]
  faqGlobal: KnowledgeFaqEntry[]
  relations: KnowledgeRelation[]
}

export type KnowledgeSearchResult = {
  chunk: KnowledgeChunk
  score: number
}

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

  const warehouse: KnowledgeWarehouse = {
    generatedAt,
    topicCount: topicRefs.length,
    chunkCount: chunks.length,
    moduleCount: modules.length,
    conceptCount: concepts.length,
    faqCount: faqGlobal.length,
    topics: topicRefs,
    modules,
    concepts,
    faqGlobal,
    relations,
  }

  await writeJsonFile(botConfig.knowledgeWarehouseFile, warehouse)
  await writeJsonFile(path.join(botConfig.knowledgeCatalogDir, 'topics.json'), topicRefs)
  await writeJsonFile(path.join(botConfig.knowledgeCatalogDir, 'modules.json'), modules)
  await writeJsonFile(path.join(botConfig.knowledgeCatalogDir, 'concepts.json'), concepts)
  await writeJsonFile(path.join(botConfig.knowledgeCatalogDir, 'faq-global.json'), faqGlobal)
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
  if (warehouse) {
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

  for (const deadline of topic.agentMemory?.deadlines ?? []) {
    chunks.push(createChunk(topic, 'deadline', basePath, deadline, capturedAt))
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

async function writeChunksJsonl(chunks: KnowledgeChunk[]) {
  const chunksFile = path.join(botConfig.knowledgeIndexDir, 'chunks.jsonl')
  const content = chunks.map((chunk) => JSON.stringify(chunk)).join('\n')
  await fs.writeFile(chunksFile, content ? `${content}\n` : '', 'utf-8')
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

function hashText(text: string) {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0
  }
  return hash.toString(16)
}

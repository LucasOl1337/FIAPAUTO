import type { SubjectTopic, TopicAgentMemory } from './subjectTopics.ts'
import type { LibraryMatch, LibrarySourceType } from '@fiapauto/contracts'
import {
  searchKnowledgeChunks,
  searchKnowledgeLibrary,
  toLibraryMatch,
  type KnowledgeChunk,
} from './knowledgeWarehouse.ts'
import { classifyQuestionIntent, type QuestionIntent } from './questionIntentClassifier.ts'
import type { ConversationState } from './conversationStateStore.ts'

export type TopicCitation = {
  sourceType: 'summary' | 'faq' | 'deliverable' | 'content'
  sourceLabel: string
  snippet: string
}

export type TopicContextBundle = {
  intent: QuestionIntent
  documents: Array<{ name: string; content: string }>
  citations: TopicCitation[]
  localCitations: TopicCitation[]
  libraryCitations: TopicLibraryCitation[]
  keyFacts: string[]
  deliverableHints: string[]
  numberedHints: string[]
  conversationSummary: string
  libraryMatches: LibraryMatch[]
  libraryDecision: TopicLibraryDecision
}

export type TopicLibraryCitation = {
  sourceType: LibrarySourceType
  sourceLabel: string
  snippet: string
}

export type TopicLibraryDecision = {
  question: string
  summary: string
  considered: number
  accepted: number
  rejected: number
}

export async function buildTopicContextBundle(input: {
  topic: SubjectTopic
  memory: TopicAgentMemory
  question: string
  conversation: ConversationState | null
}) {
  const intent = classifyQuestionIntent(input.question)
  const preferredSourceTypes = mapIntentToPreferredSourceTypes(intent)
  const keyFacts = selectKeyFacts(input.memory, intent)
  const deliverableHints = selectHints(input.memory.deliverables, intent === 'numbered_item' ? 1 : 4)
  const searchResults = await searchKnowledgeChunks({
    query: input.question,
    topicId: input.topic.id,
    preferredSourceTypes,
    limit: 4,
  })
  const localCitations = buildCitations(input.topic, input.memory, searchResults.map((item) => item.chunk), intent)
  const numberedHints = findNumberedHints(input.topic, input.memory, input.question)
  const rawLibraryResults = await searchKnowledgeLibrary({
    query: input.question,
    currentTopicId: input.topic.id,
    currentTopicTitle: input.topic.title,
    currentModuleKey: input.topic.moduleKey,
    currentDeliverables: input.memory.deliverables,
    intent,
    limit: 5,
  })
  const minimumScore = intent === 'deliverable' || intent === 'grading' || intent === 'format'
    ? 9
    : intent === 'explanation' || intent === 'next_steps'
      ? 7
      : 8
  const libraryMatches = rawLibraryResults.map((result) => {
    const accepted = result.score >= minimumScore
    const reason = accepted
      ? result.entry.sourceType === 'official_chunk'
        ? 'Aceito: caso parecido com base oficial forte.'
        : result.entry.sourceType === 'validated_answer'
          ? 'Aceito: resposta validada com grounding suficiente.'
          : 'Aceito: padrao didatico parecido para explicar o trabalho.'
      : `Descartado: score abaixo do limiar minimo (${minimumScore}).`
    return toLibraryMatch(result, accepted, reason)
  })
  const acceptedLibraryMatches = libraryMatches.filter((item) => item.usedInAnswer).slice(0, 2)
  const libraryCitations = acceptedLibraryMatches.map((item) => ({
    sourceType: item.sourceType,
    sourceLabel: `${item.topicTitle} (${item.sourceType})`,
    snippet: item.snippet,
  })) satisfies TopicLibraryCitation[]
  const libraryDecision = {
    question: input.question,
    summary: acceptedLibraryMatches.length > 0
      ? 'Biblioteca usada como apoio para explicar casos parecidos sem substituir a base local.'
      : 'Biblioteca ignorada para esta pergunta porque nao atingiu confianca suficiente.',
    considered: libraryMatches.length,
    accepted: acceptedLibraryMatches.length,
    rejected: Math.max(0, libraryMatches.length - acceptedLibraryMatches.length),
  } satisfies TopicLibraryDecision
  const documents = [
    {
      name: `${input.topic.id}.summary.txt`,
      content: input.topic.summary || input.memory.overview,
    },
    {
      name: `${input.topic.id}.memory.txt`,
      content: JSON.stringify({
        overview: input.memory.overview,
        deliverables: input.memory.deliverables,
        keyFacts,
        faq: intent === 'numbered_item' ? [] : input.memory.faq.filter((item) => isGroundedFaq(item, intent)).slice(0, 4),
      }),
    },
    {
      name: `${input.topic.id}.context.txt`,
      content: [...localCitations.map((item) => `${item.sourceType}: ${item.snippet}`), ...numberedHints.map((item) => `numbered: ${item}`)].join('\n'),
    },
  ]

  if (acceptedLibraryMatches.length > 0) {
    documents.push({
      name: `${input.topic.id}.library.txt`,
      content: [
        'Casos parecidos da biblioteca global. Use apenas como apoio de explicacao.',
        'Nunca trate isso como fato confirmado do topico atual sem confirmacao nas fontes locais.',
        ...acceptedLibraryMatches.map((item, index) => `${index + 1}. ${item.topicTitle} [${item.sourceType}] ${item.question ? `Pergunta: ${item.question}. ` : ''}${item.snippet}`),
      ].join('\n'),
    })
  }

  if (input.conversation?.summary) {
    documents.push({
      name: `${input.topic.id}.conversation.txt`,
      content: input.conversation.summary,
    })
  }

  return {
    intent,
    documents,
    citations: localCitations,
    localCitations,
    libraryCitations,
    keyFacts,
    deliverableHints,
    numberedHints,
    conversationSummary: input.conversation?.summary ?? '',
    libraryMatches,
    libraryDecision,
  } satisfies TopicContextBundle
}

function buildCitations(
  topic: SubjectTopic,
  memory: TopicAgentMemory,
  chunks: KnowledgeChunk[],
  intent: QuestionIntent,
) {
  const citations: TopicCitation[] = []

  if (topic.summary) {
    citations.push({
      sourceType: 'summary',
      sourceLabel: 'Resumo do topico',
      snippet: topic.summary.slice(0, 220),
    })
  }

  if (intent !== 'numbered_item') {
    for (const faq of memory.faq.filter((item) => isGroundedFaq(item, intent)).slice(0, 2)) {
      citations.push({
        sourceType: 'faq',
        sourceLabel: faq.question,
        snippet: faq.answer.slice(0, 220),
      })
    }
  }

  for (const deliverable of memory.deliverables.slice(0, intent === 'deliverable' ? 2 : 1)) {
    citations.push({
      sourceType: 'deliverable',
      sourceLabel: 'Entregavel identificado',
      snippet: deliverable.slice(0, 220),
    })
  }

  for (const chunk of chunks.slice(0, 3)) {
    citations.push({
      sourceType: mapChunkSourceType(chunk.sourceType),
      sourceLabel: `Trecho do material (${chunk.sourceType})`,
      snippet: chunk.text.slice(0, 240),
    })
  }

  return dedupeCitations(citations).slice(0, 6)
}

function mapIntentToPreferredSourceTypes(intent: QuestionIntent) {
  if (intent === 'deliverable') {
    return ['deliverable', 'summary', 'content'] satisfies KnowledgeChunk['sourceType'][]
  }

  if (intent === 'grading' || intent === 'format') {
    return ['faq', 'content', 'summary'] satisfies KnowledgeChunk['sourceType'][]
  }

  if (intent === 'numbered_item') {
    return ['content', 'faq', 'summary'] satisfies KnowledgeChunk['sourceType'][]
  }

  return ['summary', 'faq', 'content'] satisfies KnowledgeChunk['sourceType'][]
}

function mapChunkSourceType(
  sourceType: KnowledgeChunk['sourceType'],
): TopicCitation['sourceType'] {
  if (sourceType === 'deliverable') {
    return 'deliverable'
  }

  if (sourceType === 'faq') {
    return 'faq'
  }

  if (sourceType === 'summary' || sourceType === 'overview') {
    return 'summary'
  }

  return 'content'
}

function dedupeCitations(citations: TopicCitation[]) {
  const seen = new Set<string>()
  return citations.filter((item) => {
    const key = `${item.sourceType}:${item.snippet}`.trim()
    if (!key || seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}

function findNumberedHints(topic: SubjectTopic, memory: TopicAgentMemory, question: string) {
  const match = question.match(/\b(?:topico|tópico|item|questao|questão|parte|exercicio|exercício)\s*(?:numero\s*)?(\d+)\b/i)
  if (!match) {
    return []
  }

  const target = Number.parseInt(match[1] ?? '', 10)
  if (!Number.isFinite(target)) {
    return []
  }

  const exactSections = extractNumberedSections(topic.contentText, target)
  if (exactSections.length > 0) {
  return exactSections.slice(0, 1).map((item) => item.slice(0, 500))
  }

  const variants = new Set([
    `${target})`,
    `${String(target).padStart(2, '0')})`,
    `${target}.`,
    `${String(target).padStart(2, '0')}.`,
  ])
  const haystack = [topic.contentText, ...memory.sourceSnippets, memory.overview]
    .join('\n')
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean)

  return haystack
    .filter((item) => Array.from(variants).some((variant) => item.includes(variant)))
    .slice(0, 4)
    .map((item) => item.slice(0, 320))
}

function extractNumberedSections(content: string, target: number) {
  const normalizedTarget = String(target).padStart(2, '0')
  const lines = content
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean)

  const startPattern = new RegExp(`^(?:${target}|${normalizedTarget})[).]\\s*`)
  const paddedPattern = new RegExp(`^${normalizedTarget}[).]\\s*`)
  const nextPattern = /^(?:0?\d+)[).]\s*/
  const sections: Array<{ text: string; score: number }> = []

  for (let index = 0; index < lines.length; index += 1) {
    const currentLine = lines[index] ?? ''
    if (!startPattern.test(currentLine)) {
      continue
    }

    const buffer = [currentLine]
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? ''
      if (!line) {
        continue
      }

      if (startPattern.test(line) || nextPattern.test(line) || /^PARTE\b/i.test(line)) {
        break
      }

      buffer.push(line)
    }

    const text = buffer.join(' ')
    let score = 0
    if (paddedPattern.test(currentLine)) {
      score += 5
    }
    if (/\)\s/.test(currentLine)) {
      score += 3
    }
    if (/^PARTE\b/i.test(lines[index - 1] ?? '')) {
      score += 2
    }

    sections.push({ text, score })
  }

  return dedupeStrings(
    sections
      .sort((left, right) => right.score - left.score || right.text.length - left.text.length)
      .map((item) => item.text),
  )
}

function isGroundedFaq(
  faq: TopicAgentMemory['faq'][number],
  intent: QuestionIntent,
) {
  const question = faq.question.trim().toLowerCase()
  const answer = faq.answer.trim()

  if (!question || !answer) {
    return false
  }

  if (/\b(teste|oi|ola|olá|ae|aee|blz)\b/i.test(question)) {
    return false
  }

  if (
    intent === 'numbered_item' &&
    /\b(nao encontrei|não encontrei|nenhuma referencia|nenhuma referência)\b/i.test(answer)
  ) {
    return false
  }

  return answer.length >= 40
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

function selectKeyFacts(memory: TopicAgentMemory, intent: QuestionIntent) {
  if (intent === 'numbered_item') {
    return []
  }

  return memory.keyFacts.slice(0, 6)
}

function selectHints(values: string[], limit: number) {
  return values
    .filter((item) => !/\*\*|item\s*[0-9]+/i.test(item))
    .slice(0, limit)
}

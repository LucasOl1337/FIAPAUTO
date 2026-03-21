import type { SubjectTopic, TopicAgentMemory } from './subjectTopics.ts'
import { searchKnowledgeChunks, type KnowledgeChunk } from './knowledgeWarehouse.ts'
import { classifyQuestionIntent, type QuestionIntent } from './questionIntentClassifier.ts'
import type { ConversationState } from './conversationStateStore.ts'

export type TopicCitation = {
  sourceType: 'summary' | 'faq' | 'deadline' | 'deliverable' | 'content'
  sourceLabel: string
  snippet: string
}

export type TopicContextBundle = {
  intent: QuestionIntent
  documents: Array<{ name: string; content: string }>
  citations: TopicCitation[]
  keyFacts: string[]
  deadlineHints: string[]
  deliverableHints: string[]
  numberedHints: string[]
  conversationSummary: string
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
  const deadlineHints = selectHints(input.memory.deadlines, intent === 'numbered_item' ? 1 : 4)
  const deliverableHints = selectHints(input.memory.deliverables, intent === 'numbered_item' ? 1 : 4)
  const searchResults = await searchKnowledgeChunks({
    query: input.question,
    topicId: input.topic.id,
    preferredSourceTypes,
    limit: 4,
  })

  const citations = buildCitations(input.topic, input.memory, searchResults.map((item) => item.chunk), intent)
  const numberedHints = findNumberedHints(input.topic, input.memory, input.question)
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
        deadlines: input.memory.deadlines,
        keyFacts,
        faq: intent === 'numbered_item' ? [] : input.memory.faq.filter((item) => isGroundedFaq(item, intent)).slice(0, 4),
      }),
    },
    {
      name: `${input.topic.id}.context.txt`,
      content: [...citations.map((item) => `${item.sourceType}: ${item.snippet}`), ...numberedHints.map((item) => `numbered: ${item}`)].join('\n'),
    },
  ]

  if (input.conversation?.summary) {
    documents.push({
      name: `${input.topic.id}.conversation.txt`,
      content: input.conversation.summary,
    })
  }

  return {
    intent,
    documents,
    citations,
    keyFacts,
    deadlineHints,
    deliverableHints,
    numberedHints,
    conversationSummary: input.conversation?.summary ?? '',
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

  for (const deadline of memory.deadlines.slice(0, intent === 'deadline' ? 2 : 1)) {
    citations.push({
      sourceType: 'deadline',
      sourceLabel: 'Prazo identificado',
      snippet: deadline.slice(0, 220),
    })
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
  if (intent === 'deadline') {
    return ['deadline', 'summary', 'content'] satisfies KnowledgeChunk['sourceType'][]
  }

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
  if (sourceType === 'deadline') {
    return 'deadline'
  }

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

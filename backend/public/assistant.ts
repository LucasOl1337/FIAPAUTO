import fs from 'node:fs/promises'
import path from 'node:path'
import { runtimePaths } from '../config/runtimePaths.ts'
import { routeAssistantChat } from '../connections/llm/providerRouter.ts'
import { classifyQuestionIntent } from '../engine/questionIntentClassifier.ts'
import type { PublicChatResponse, PublicTopic, PublishedKnowledgeChunk } from '../apis/contracts/index.ts'

type Citation = PublicChatResponse['citations'][number]

export async function answerPublishedTopicQuestion(input: {
  topic: PublicTopic
  chunks: PublishedKnowledgeChunk[]
  question: string
}) {
  const intent = classifyQuestionIntent(input.question)
  const scopedChunks = input.chunks.filter((chunk) => chunk.topicId === input.topic.id)
  const rankedChunks = rankChunks(scopedChunks, input.question)
  const citations = rankedChunks.slice(0, 3).map((chunk) => ({
    sourceType: chunk.sourceType === 'overview' ? 'summary' : chunk.sourceType,
    sourceLabel: `${input.topic.title} / ${chunk.sourceType}`,
    snippet: chunk.text,
  })) satisfies Citation[]

  const deterministic = buildDeterministicAnswer({
    topic: input.topic,
    citations,
    intent,
  })
  const prompt = buildPrompt({
    topic: input.topic,
    question: input.question,
    rankedChunks: rankedChunks.slice(0, 6),
  })
  const documents = buildDocuments(input.topic, citations)
  const images = await readTopicImages(input.topic)

  try {
    const providerResponse = await routeAssistantChat({
      jobId: `public-topic-ask-${input.topic.id}-${Date.now()}`,
      topicId: input.topic.id,
      prompt,
      documents,
      images,
    })

    return {
      topicId: input.topic.id,
      answer: providerResponse.answer || deterministic,
      confidence: citations.length >= 2 ? 'high' : citations.length === 1 ? 'medium' : 'low',
      strategyUsed: providerResponse.strategyUsed,
      providerUsed: providerResponse.providerUsed,
      fallbackLevel: providerResponse.fallbackLevel,
      citations,
      suggestedQuestions: buildSuggestedQuestions(intent),
      nextSteps: buildNextSteps(input.topic),
      answeredAt: new Date().toISOString(),
    } satisfies PublicChatResponse
  } catch {
    // Fall back to the deterministic response below.
  }

  return {
    topicId: input.topic.id,
    answer: deterministic,
    confidence: citations.length >= 2 ? 'high' : citations.length === 1 ? 'medium' : 'low',
    strategyUsed: input.topic.agentMemory ? 'memory' : 'deterministic',
    providerUsed: 'local',
    fallbackLevel: 2,
    citations,
    suggestedQuestions: buildSuggestedQuestions(intent),
    nextSteps: buildNextSteps(input.topic),
    answeredAt: new Date().toISOString(),
  } satisfies PublicChatResponse
}

function buildDeterministicAnswer(input: {
  topic: PublicTopic
  citations: Citation[]
  intent: ReturnType<typeof classifyQuestionIntent>
}) {
  if (input.intent === 'deadline') {
    return `O prazo principal identificado para ${input.topic.title} e ${input.topic.dueText || 'nao encontrado no material publicado'}.`
  }

  if (input.intent === 'deliverable') {
    const deliverables = input.topic.agentMemory?.deliverables ?? []
    return deliverables.length > 0
      ? `Os entregaveis publicados para ${input.topic.title} sao: ${deliverables.slice(0, 4).join(', ')}.`
      : 'Os entregaveis nao ficaram totalmente claros no material publicado. Abra o anexo principal para confirmar.'
  }

  if (input.intent === 'summary') {
    return input.topic.summary || input.citations[0]?.snippet || `Ainda nao existe resumo publicado para ${input.topic.title}.`
  }

  if (input.intent === 'next_steps') {
    return buildNextSteps(input.topic).join(' ')
  }

  if (input.intent === 'grading' || input.intent === 'format') {
    const fact = input.topic.agentMemory?.keyFacts.find((item) => /nota|atraso|abnt|formato|links|avali/i.test(item))
    return fact || input.citations[0]?.snippet || 'Nao encontrei uma regra objetiva sobre avaliacao no material publicado.'
  }

  if (input.intent === 'numbered_item' && input.citations[0]) {
    return `O trecho mais relevante que encontrei para esse item foi: ${input.citations[0].snippet}`
  }

  return input.citations[0]?.snippet
    || input.topic.agentMemory?.overview
    || input.topic.summary
    || `Posso te ajudar com ${input.topic.title}. Pergunte sobre prazo, entregaveis ou checklist para eu ser mais objetivo.`
}

function buildPrompt(input: {
  topic: PublicTopic
  question: string
  rankedChunks: PublishedKnowledgeChunk[]
}) {
  const learningFaq = (input.topic.learning?.frequentQuestions ?? [])
    .slice(0, 4)
    .map((item) => `- ${item.question}: ${item.answer}`)
    .join('\n')
  const keyFacts = (input.topic.agentMemory?.keyFacts ?? [])
    .slice(0, 8)
    .map((item) => `- ${item}`)
    .join('\n')
  const chunkBlock = input.rankedChunks
    .map((chunk, index) => `[${index + 1}] ${chunk.sourceType}: ${chunk.text}`)
    .join('\n\n')

  return [
    'Voce e o assistente publico do FIAPAUTO.',
    'Responda em portugues do Brasil, de forma objetiva, natural e util para um aluno cansado e com pressa.',
    'Use apenas o material fornecido.',
    'Se algo nao estiver confirmado no material, diga explicitamente que nao encontrou.',
    'Se as imagens ajudarem, use-as para complementar a resposta.',
    '',
    `Materia: ${input.topic.title}`,
    `Curso: ${input.topic.course}`,
    `Modulo: ${input.topic.moduleKey}`,
    `Status: ${input.topic.status}`,
    `Prazo publicado: ${input.topic.dueText || 'nao encontrado'}`,
    '',
    'Resumo publicado:',
    input.topic.summary || 'Nao existe resumo publicado.',
    '',
    'Memoria do agente:',
    input.topic.agentMemory?.overview || 'Nao existe memoria publicada.',
    '',
    'Fatos importantes:',
    keyFacts || '- Nenhum fato importante publicado.',
    '',
    'FAQ / aprendizado:',
    learningFaq || '- Nenhum FAQ publicado.',
    '',
    'Trechos relevantes do material:',
    chunkBlock || 'Nenhum trecho relevante encontrado.',
    '',
    `Pergunta do usuario: ${input.question}`,
    '',
    'Formato da resposta:',
    '- Comece respondendo diretamente.',
    '- Se fizer sentido, traga checklist curto ou proximos passos.',
    '- Nao invente prazos, entregaveis ou regras.',
  ].join('\n')
}

function buildDocuments(topic: PublicTopic, citations: Citation[]) {
  return [
    {
      name: `${topic.id}.summary.txt`,
      content: topic.summary || '',
    },
    {
      name: `${topic.id}.memory.txt`,
      content: JSON.stringify({
        overview: topic.agentMemory?.overview ?? '',
        deliverables: topic.agentMemory?.deliverables ?? [],
        deadlines: topic.agentMemory?.deadlines ?? [],
        keyFacts: topic.agentMemory?.keyFacts ?? [],
      }),
    },
    {
      name: `${topic.id}.learning.txt`,
      content: JSON.stringify({
        frequentQuestions: topic.learning?.frequentQuestions ?? [],
        quickTips: topic.learning?.quickTips ?? [],
      }),
    },
    {
      name: `${topic.id}.citations.txt`,
      content: citations.map((item) => `${item.sourceType}: ${item.snippet}`).join('\n'),
    },
  ].filter((item) => item.content.trim())
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

function buildNextSteps(topic: PublicTopic) {
  return [
    `Revise o resumo de ${topic.title}.`,
    'Abra o anexo principal para confirmar detalhes finos.',
    `Valide o prazo final: ${topic.dueText || 'nao encontrado'}.`,
  ]
}

function buildSuggestedQuestions(intent: ReturnType<typeof classifyQuestionIntent>) {
  if (intent === 'deadline') {
    return ['O que preciso entregar?', 'Me faca um checklist', 'O que pode me fazer perder pontos?']
  }

  if (intent === 'deliverable') {
    return ['Qual e o prazo?', 'Explique este trabalho de forma simples', 'Me faca um checklist']
  }

  return ['O que preciso entregar?', 'Qual e o prazo?', 'Me faca um checklist']
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
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3 || /^\d+$/.test(item))
}

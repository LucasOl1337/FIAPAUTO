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

  return {
    topicId: input.topic.id,
    answer,
    confidence: citations.length >= 2 ? 'high' : citations.length === 1 ? 'medium' : 'low',
    strategyUsed: 'rag_llm',
    providerUsed: 'ollama',
    fallbackLevel: 0,
    citations,
    suggestedQuestions: buildSuggestedQuestions(input.topic),
    nextSteps: buildNextSteps(input.topic),
    answeredAt: new Date().toISOString(),
  } satisfies PublicCloudChatResponse
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
  const frequentQuestions = (input.topic.learning?.frequentQuestions ?? [])
    .slice(0, 4)
    .map((item) => `- ${item.question}: ${item.answer}`)
    .join('\n')
  const quickTips = (input.topic.learning?.quickTips ?? []).slice(0, 4).map((item) => `- ${item}`).join('\n')
  const keyFacts = (input.topic.agentMemory?.keyFacts ?? []).slice(0, 8).map((item) => `- ${item}`).join('\n')
  const chunksBlock = input.rankedChunks.map((chunk, index) => `[${index + 1}] ${chunk.sourceType}: ${chunk.text}`).join('\n\n')

  return [
    'Voce e o assistente publico do FIAPAUTO.',
    'Responda em portugues do Brasil, de forma objetiva, clara e util para um aluno.',
    'Use apenas o contexto fornecido abaixo. Se algo nao estiver no material, diga explicitamente que nao encontrou.',
    'Quando houver prazo incerto, sinalize a incerteza.',
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
    'Fatos rapidos:',
    keyFacts || '- Nenhum fato rapido publicado.',
    '',
    'FAQ / aprendizado:',
    frequentQuestions || '- Nenhum FAQ publicado.',
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
    '- Comece com uma resposta curta e direta.',
    '- Depois, se ajudar, inclua checklist ou proximos passos.',
    '- Nao invente dados.',
    '- Se as imagens anexadas ajudarem, use-as tambem.',
  ].join('\n')
}

function buildNextSteps(topic: PublicTopic) {
  return [
    `Reveja o resumo de ${topic.title}.`,
    'Abra o arquivo principal para validar detalhes finos.',
    `Confirme o prazo final: ${topic.dueText || 'nao encontrado'}.`,
  ]
}

function buildSuggestedQuestions(topic: PublicTopic) {
  return [
    `O que preciso entregar em ${topic.title}?`,
    'Qual e o prazo real dessa materia?',
    'Me faca um checklist do que preciso fazer agora.',
  ]
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

import type {
  PublicChatResponse,
  PublicManifest,
  PublicSyncStatus,
  PublicTopic,
  PublicTopicListItem,
  PublishedKnowledgeChunk,
} from '@fiapauto/contracts'

export type PublicApiEnv = {
  ASSETS: {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  }
  OLLAMA_BASE_URL?: string
  PUBLIC_LLM_MODEL?: string
  OLLAMA_MODEL?: string
  PUBLIC_LLM_TIMEOUT_MS?: string
  OLLAMA_TIMEOUT_MS?: string
}

const PUBLISHED_ROOT = '/published'

export async function handlePublicApiRequest(request: Request, env: PublicApiEnv) {
  const url = new URL(request.url)

  if (request.method === 'OPTIONS') {
    return jsonResponse(null, 204)
  }

  if (url.pathname === '/api/public' || url.pathname === '/api/public/') {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET')
    }

    return jsonResponse({
      ok: true,
      service: 'fiapauto-public-api',
      runtime: 'cloudflare-pages',
    })
  }

  if (url.pathname === '/api/public/manifest') {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET')
    }

    const manifest = await readPublishedJson<PublicManifest | null>(env, request, 'manifest.json', null)
    return manifest ? jsonResponse(manifest) : notFound('public_manifest_not_found')
  }

  if (url.pathname === '/api/public/topics') {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET')
    }

    const topics = await readPublishedJson<PublicTopicListItem[]>(env, request, 'topics.json', [])
    return jsonResponse({ topics })
  }

  if (url.pathname === '/api/public/sync/status') {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET')
    }

    const manifest = await readPublishedJson<PublicManifest | null>(env, request, 'manifest.json', null)
    const payload: PublicSyncStatus = manifest
      ? {
          localReleaseId: manifest.releaseId,
          localPublishedAt: manifest.publishedAt,
          remoteReleaseId: manifest.releaseId,
          remotePublishedAt: manifest.publishedAt,
          inSync: true,
          bucket: 'cloudflare-pages',
          region: 'global',
        }
      : {
          inSync: false,
          bucket: 'cloudflare-pages',
          region: 'global',
        }

    return jsonResponse(payload)
  }

  if (url.pathname === '/api/public/assets') {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET')
    }

    const key = url.searchParams.get('key')?.trim() ?? ''
    if (!key) {
      return badRequest('asset_key_required')
    }

    return await readPublishedAsset(env, request, key)
  }

  if (url.pathname === '/api/public/chat/topic') {
    if (request.method !== 'POST') {
      return methodNotAllowed('POST')
    }

    const body = await readJsonBody(request)
    const topicId = typeof body.topicId === 'string' ? body.topicId.trim() : ''
    const question = typeof body.question === 'string' ? body.question.trim() : ''

    if (!topicId) {
      return badRequest('topic_id_required')
    }

    if (!question) {
      return badRequest('question_required')
    }

    const topic = await readPublishedJson<PublicTopic | null>(env, request, `topics/${encodeURIComponent(topicId)}.json`, null)
    if (!topic) {
      return notFound('public_topic_not_found')
    }

    const chunks = await readPublishedJson<PublishedKnowledgeChunk[]>(env, request, 'knowledge/chunks.json', [])
    const ollamaAnswer = await tryRemoteOllamaChat(env, topic, chunks, question)
    if (!ollamaAnswer) {
      return serviceUnavailable('ollama_unavailable')
    }

    return jsonResponse(ollamaAnswer)
  }

  if (url.pathname === '/api/public/auth/sign-up'
    || url.pathname === '/api/public/auth/sign-in'
    || url.pathname === '/api/public/auth/guest'
    || url.pathname === '/api/public/auth/me'
    || url.pathname === '/api/public/auth/ping'
    || url.pathname === '/api/public/auth/sign-out') {
    return jsonResponse(
      {
        error: 'public_auth_not_enabled_on_cloudflare_pages',
      },
      501,
    )
  }

  if (url.pathname.startsWith('/api/public/topics/')) {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET')
    }

    const topicId = normalizeTopicId(url.pathname)
    if (!topicId) {
      return badRequest('topic_id_required')
    }

    const topic = await readPublishedJson<PublicTopic | null>(env, request, `topics/${encodeURIComponent(topicId)}.json`, null)
    return topic ? jsonResponse(topic) : notFound('public_topic_not_found')
  }

  return notFound('not_found')
}

async function readPublishedJson<T>(env: PublicApiEnv, request: Request, relativePath: string, fallback: T) {
  const response = await env.ASSETS.fetch(buildPublishedUrl(request, relativePath))
  if (!response.ok) {
    return fallback
  }

  try {
    return (await response.json()) as T
  } catch {
    return fallback
  }
}

async function readPublishedAsset(env: PublicApiEnv, request: Request, key: string) {
  const response = await env.ASSETS.fetch(buildPublishedUrl(request, key))
  if (!response.ok) {
    return notFound('public_asset_not_found')
  }

  return response
}

function buildPublishedUrl(request: Request, relativePath: string) {
  const sanitized = relativePath.replace(/^\/+/, '')
  return new URL(`${PUBLISHED_ROOT}/${sanitized}`, request.url)
}

async function readJsonBody(request: Request) {
  try {
    return await request.json()
  } catch {
    return {}
  }
}

function normalizeTopicId(pathname: string) {
  const raw = pathname.replace('/api/public/topics/', '').split('/')[0] ?? ''
  try {
    return decodeURIComponent(raw).trim()
  } catch {
    return raw.trim()
  }
}

async function tryRemoteOllamaChat(
  env: PublicApiEnv,
  topic: PublicTopic,
  chunks: PublishedKnowledgeChunk[],
  question: string,
) {
  const baseUrl = normalizeBaseUrl(env.OLLAMA_BASE_URL)
  if (!baseUrl) {
    return null
  }

  const timeoutMs = parseTimeout(env.OLLAMA_TIMEOUT_MS ?? env.PUBLIC_LLM_TIMEOUT_MS, 120000)
  const model = normalizeModel(env.OLLAMA_MODEL ?? env.PUBLIC_LLM_MODEL ?? 'qwen3.5:397b-cloud')
  const prompt = buildOllamaPrompt(topic, chunks, question)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort('ollama_timeout'), timeoutMs)

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          {
            role: 'system',
            content: 'Voce e o assistente academico do FIAPAUTO. Responda em portugues do Brasil, de forma clara e objetiva.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      return null
    }

    const payload = (await response.json()) as {
      message?: {
        content?: string
      }
      response?: string
      content?: string
    }

    const answer = (
      payload.message?.content
      ?? payload.response
      ?? payload.content
      ?? ''
    ).trim()

    if (!answer) {
      return null
    }

    return buildOllamaChatResponse(topic, chunks, question, answer)
  } catch {
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}

function buildOllamaChatResponse(topic: PublicTopic, chunks: PublishedKnowledgeChunk[], question: string, answer: string): PublicChatResponse {
  const citations = buildCitations(topic, chunks, question)
  const deliverables = buildDeliverables(topic)
  const attentionPoints = buildAttentionPoints(topic)
  const nextSteps = buildNextSteps(topic, deliverables)
  const questions = buildSuggestedQuestions(topic)
  const summary10s = clip(answer.split(/\n+/)[0] ?? answer, 180) || buildSummary(topic, citations)

  return {
    topicId: topic.id,
    answer,
    sections: {
      summary10s,
      fullAnswer: [answer],
      deliverables,
      attentionPoints,
      nextSteps,
      followUpQuestions: questions,
      answerMode: citations.length >= 2 ? 'grounded' : citations.length === 1 ? 'mixed' : 'general_guidance',
    },
    confidence: citations.length >= 2 ? 'high' : citations.length === 1 ? 'medium' : 'low',
    strategyUsed: 'rag_llm',
    providerUsed: 'ollama',
    fallbackLevel: 0,
    citations,
    suggestedQuestions: questions,
    nextSteps,
    answeredAt: new Date().toISOString(),
    qualityStatus: 'accepted',
    qualityReason: 'Resposta gerada pelo Ollama configurado no Cloudflare Pages.',
    answeredByPass: 'primary',
  }
}

function buildOllamaPrompt(topic: PublicTopic, chunks: PublishedKnowledgeChunk[], question: string) {
  const contextLines = [
    `Topico: ${topic.title}`,
    `Curso: ${topic.course}`,
    `Resumo: ${topic.summary}`,
    ...(topic.learning?.frequentQuestions ?? []).slice(0, 3).map((item) => `FAQ: ${item.question} - ${item.answer}`),
    ...(topic.learning?.learningTopics ?? []).slice(0, 3).map((item) => `Aprendizado: ${item.title} - ${item.explanation}`),
    ...chunks.slice(0, 6).map((chunk) => `${chunk.sourceType}: ${chunk.text}`),
  ]

  return [
    'Responda em portugues do Brasil, de forma objetiva e util para um aluno.',
    'Use apenas o material fornecido abaixo.',
    'Formato esperado:',
    'RESPOSTA DIRETA: ...',
    'O QUE ENTREGAR: ...',
    'ATENCAO: ...',
    'PROXIMO PASSO: ...',
    '',
    `Pergunta: ${question}`,
    '',
    ...contextLines,
  ].join('\n')
}

function normalizeBaseUrl(value: string | undefined) {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) {
    return ''
  }

  return trimmed.replace(/\/+$/, '')
}

function normalizeModel(value: string) {
  return value.trim() || 'qwen3.5:397b-cloud'
}

function parseTimeout(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function buildCitations(topic: PublicTopic, chunks: PublishedKnowledgeChunk[], question: string) {
  const ranked = chunks
    .map((chunk) => ({
      chunk,
      score: scoreChunk(chunk, question),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)

  const citations = ranked
    .filter((item) => item.score > 0)
    .map((item) => ({
      sourceType: item.chunk.sourceType,
      sourceLabel: `${topic.title} / ${item.chunk.sourceType}`,
      snippet: clip(item.chunk.text, 220),
    }))

  if (citations.length > 0) {
    return citations
  }

  const fallbackSnippets = [
    topic.summary,
    topic.agentMemory?.overview ?? '',
    ...(topic.learning?.frequentQuestions ?? []).slice(0, 1).map((item) => item.answer),
  ]
    .map((snippet) => snippet.trim())
    .filter(Boolean)

  return fallbackSnippets.slice(0, 3).map((snippet, index) => ({
    sourceType: index === 0 ? 'summary' : 'faq',
    sourceLabel: `${topic.title} / fallback-${index + 1}`,
    snippet: clip(snippet, 220),
  }))
}

function buildDeliverables(topic: PublicTopic) {
  const values = [
    ...(topic.agentMemory?.deliverables ?? []),
    ...topic.attachments.map((item) => item.name),
  ]

  return uniqueNonEmpty(values)
    .map((item) => clip(item, 80))
    .slice(0, 3)
}

function buildAttentionPoints(topic: PublicTopic) {
  const values = [
    ...(topic.agentMemory?.deadlines ?? []),
    ...(topic.warnings ?? []),
    topic.dueText,
  ]

  return uniqueNonEmpty(values)
    .map((item) => clip(item, 90))
    .slice(0, 3)
}

function buildNextSteps(topic: PublicTopic, deliverables: string[]) {
  const nextSteps = [
    `Leia o resumo de ${topic.title}.`,
    deliverables[0] ? `Valide o entregavel principal: ${deliverables[0]}.` : 'Abra os anexos e revise os pontos centrais.',
    `Se algo estiver ambiguo, confira o material original antes de entregar.`,
  ]

  return nextSteps.slice(0, 3)
}

function buildSuggestedQuestions(topic: PublicTopic) {
  return uniqueNonEmpty([
    ...(topic.learning?.frequentQuestions ?? []).map((item) => item.question),
    'Me faca um checklist',
    'O que pode me fazer perder pontos?',
  ]).slice(0, 3)
}

function buildSummary(topic: PublicTopic, citations: Array<{ snippet: string }>) {
  const summary = topic.summary.trim()
  if (summary) {
    return clip(summary, 180)
  }

  const fallback = citations[0]?.snippet ?? `Este topico trata de ${topic.title}.`
  return clip(fallback, 180)
}

function scoreChunk(chunk: PublishedKnowledgeChunk, question: string) {
  const questionTokens = tokenize(question)
  const normalizedText = normalize(chunk.text)
  const normalizedKeywords = chunk.keywords.map((item) => normalize(item))

  return questionTokens.reduce((total, token) => {
    let next = total
    if (normalizedText.includes(token)) {
      next += 1
    }
    if (normalizedKeywords.includes(token)) {
      next += 2
    }
    if (chunk.topicId && normalize(chunk.topicId).includes(token)) {
      next += 1
    }
    return next
  }, 0)
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

function uniqueNonEmpty(values: string[]) {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of values) {
    const cleaned = value.trim()
    if (!cleaned) {
      continue
    }

    const key = normalize(cleaned)
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    result.push(cleaned)
  }

  return result
}

function clip(value: string, maxLength: number) {
  const cleaned = value.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxLength) {
    return cleaned
  }

  return `${cleaned.slice(0, maxLength - 3).trimEnd()}...`
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(payload === null ? null : JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  })
}

function badRequest(error: string) {
  return jsonResponse({ error }, 400)
}

function notFound(error: string) {
  return jsonResponse({ error }, 404)
}

function serviceUnavailable(error: string) {
  return jsonResponse({ error }, 503)
}

function methodNotAllowed(allow: string) {
  return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
    status: 405,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Allow': allow,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  })
}

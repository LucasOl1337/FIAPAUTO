import { llmBaseUrl, postLlmChat, resolveApiKeyWithMeta, type LlmDocument, type LlmImage } from './llmClient.ts'
import { postGeminiChat, readGeminiLocalKeys, type GeminiKeyEntry } from './geminiClient.ts'
import { postOllamaChat, readOllamaLocalKeys, type OllamaKeyEntry } from './ollamaClient.ts'
import { isKeyCoolingDown, isProviderCircuitOpen, markProviderAttempt, readProviderHealth, type ProviderName } from './providerHealthStore.ts'

export type ProviderStrategy = 'rag_llm' | 'provider_fallback' | 'deterministic'

export type ProviderChatRequest = {
  jobId: string
  topicId: string
  prompt: string
  documents: LlmDocument[]
  images: LlmImage[]
}

export type ProviderChatResponse = {
  answer: string
  providerUsed: ProviderName
  strategyUsed: ProviderStrategy
  fallbackLevel: number
}

type ProviderConfig = {
  name: ProviderName
  enabled: boolean
  transport: 'native-gemini' | 'native-ollama' | 'bridge'
  baseUrl?: string
  model?: string
  apiKey?: string
  apiKeyHeader?: string
  apiKeyScheme?: string
  timeoutMs?: number
  localKeys?: Array<GeminiKeyEntry | OllamaKeyEntry>
}

const quotaErrorPattern = /(429|quota|rate limit|resource exhausted|too many requests)/i

export async function routeAssistantChat(request: ProviderChatRequest) {
  const providers = await buildProviderConfigs()
  const attempts: string[] = []

  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index]
    if (!provider.enabled) {
      continue
    }

    const providerHealth = await readProviderHealth(provider.name)
    if (isProviderCircuitOpen(providerHealth)) {
      attempts.push(`${provider.name}:circuit_open`)
      continue
    }

    const keyMeta = resolveProviderKey(provider)
    const knownKey = keyMeta.keyName
      ? providerHealth.keys.find((item) => item.keyName === keyMeta.keyName)
      : undefined

    if (knownKey && isKeyCoolingDown(knownKey)) {
      attempts.push(`${provider.name}:key_cooldown`)
      continue
    }

    try {
      const answer = await invokeProvider(provider, request, keyMeta)
      if (!answer) {
        throw new Error('empty_provider_answer')
      }

      await markProviderAttempt({
        provider: provider.name,
        keyName: keyMeta.keyName,
        success: true,
      })

      return {
        answer,
        providerUsed: provider.name,
        strategyUsed: index === 0 ? 'rag_llm' : 'provider_fallback',
        fallbackLevel: index,
      } satisfies ProviderChatResponse
    } catch (error) {
      const message = error instanceof Error ? error.message : 'provider_failed'
      attempts.push(`${provider.name}:${message}`)
      await markProviderAttempt({
        provider: provider.name,
        keyName: keyMeta.keyName,
        success: false,
        error: message,
        quotaLimited: quotaErrorPattern.test(message),
      })
    }
  }

  throw new Error(attempts.join('|') || 'no_provider_available')
}

async function buildProviderConfigs() {
  const geminiLocalKeys = await readGeminiLocalKeys()
  const ollamaLocalKeys = await readOllamaLocalKeys()
  const geminiBaseUrl = process.env.GEMINI_BASE_URL ?? process.env.LLM_BASE_URL
  const ollamaBaseUrl =
    process.env.OLLAMA_PROVIDER_BASE_URL ??
    process.env.OLLAMA_BASE_URL ??
    (process.env.LLM_HOST || process.env.LLM_PORT ? llmBaseUrl() : undefined) ??
    'https://ollama.com'

  const providerPreference = (process.env.LLM_PROVIDER_PREFERENCE ?? 'ollama-first').toLowerCase()
  const providers: ProviderConfig[] = [
    {
      name: 'ollama',
      enabled: Boolean(ollamaBaseUrl || process.env.OLLAMA_API_KEY || ollamaLocalKeys.length > 0),
      transport: 'native-ollama',
      baseUrl: ollamaBaseUrl,
      model: process.env.OLLAMA_MODEL ?? 'gpt-oss:20b',
      apiKey: process.env.OLLAMA_API_KEY,
      apiKeyHeader: process.env.OLLAMA_API_KEY_HEADER ?? 'Authorization',
      apiKeyScheme: process.env.OLLAMA_API_KEY_SCHEME ?? 'Bearer',
      timeoutMs: parseTimeout(process.env.OLLAMA_TIMEOUT_MS),
      localKeys: ollamaLocalKeys,
    },
    {
      name: 'gemini',
      enabled: Boolean(process.env.GEMINI_API_KEY || process.env.LLM_API_KEY || geminiLocalKeys.length > 0 || geminiBaseUrl),
      transport: process.env.GEMINI_BASE_URL || process.env.LLM_BASE_URL ? 'bridge' : 'native-gemini',
      baseUrl: geminiBaseUrl,
      model: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
      apiKey: process.env.GEMINI_API_KEY,
      apiKeyHeader: process.env.GEMINI_API_KEY_HEADER ?? process.env.OLLAMA_API_KEY_HEADER,
      apiKeyScheme: process.env.GEMINI_API_KEY_SCHEME ?? process.env.OLLAMA_API_KEY_SCHEME,
      timeoutMs: parseTimeout(process.env.GEMINI_TIMEOUT_MS),
      localKeys: geminiLocalKeys,
    },
  ]

  if (providerPreference === 'gemini-first') {
    return [providers[1], providers[0]]
  }

  return providers
}

function parseTimeout(value: string | undefined) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function resolveProviderKey(provider: ProviderConfig) {
  if (provider.apiKey?.trim()) {
    return {
      value: provider.apiKey.trim(),
      keyName: `${provider.name}-env`,
    }
  }

  if (provider.localKeys?.length) {
    const selected = provider.localKeys[Date.now() % provider.localKeys.length]
    return {
      value: selected.value,
      keyName: selected.name,
    }
  }

  return resolveApiKeyWithMeta()
}

async function invokeProvider(
  provider: ProviderConfig,
  request: ProviderChatRequest,
  keyMeta: { value?: string; keyName?: string },
) {
  if (provider.transport === 'native-gemini') {
    if (!keyMeta.value) {
      throw new Error('gemini_api_key_missing')
    }

    const response = await postGeminiChat({
      apiKey: keyMeta.value,
      model: provider.model ?? 'gemini-2.0-flash',
      prompt: buildGeminiPrompt(request),
      timeoutMs: provider.timeoutMs,
    })
    return response.content.trim()
  }

  if (provider.transport === 'native-ollama') {
    if (!keyMeta.value) {
      throw new Error('ollama_api_key_missing')
    }

    const response = await postOllamaChat({
      apiKey: keyMeta.value,
      model: provider.model ?? 'gpt-oss:20b',
      prompt: buildGeminiPrompt(request),
      timeoutMs: provider.timeoutMs,
      baseUrl: provider.baseUrl,
    })
    return response.content.trim()
  }

  if (!provider.baseUrl) {
    throw new Error('provider_base_url_missing')
  }

  const response = await postLlmChat({
    jobId: request.jobId,
    topicId: request.topicId,
    mode: 'default',
    message: request.prompt,
    documents: request.documents,
    images: request.images,
    requestOptions: {
      provider: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: keyMeta.value,
      apiKeyHeader: provider.apiKeyHeader,
      apiKeyScheme: provider.apiKeyScheme,
      timeoutMs: provider.timeoutMs,
      keyName: keyMeta.keyName,
    },
  })

  return response.content.trim()
}

function buildGeminiPrompt(request: ProviderChatRequest) {
  const compactDocuments = request.documents
    .map((item) => `### ${item.name}\n${item.content}`)
    .join('\n\n')
    .slice(0, 24000)

  return [
    request.prompt,
    compactDocuments ? `\nContexto recuperado:\n${compactDocuments}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

import fs from 'node:fs/promises'
import { runtimePaths } from '../../config/runtimePaths.ts'

export type OllamaKeyEntry = {
  name: string
  value: string
}

export async function readOllamaLocalKeys() {
  try {
    const raw = await fs.readFile(runtimePaths.ollamaKeysLocalFile, 'utf-8')
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map(parseOllamaKeyLine)
      .filter((item): item is OllamaKeyEntry => Boolean(item))
  } catch {
    return []
  }
}

export async function postOllamaChat(input: {
  apiKey: string
  model: string
  prompt: string
  images?: Array<{
    data?: string
    mime?: string
    name?: string
  }>
  timeoutMs?: number
  baseUrl?: string
}) {
  const baseUrl = (input.baseUrl ?? 'https://ollama.com').replace(/\/+$/, '')
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      messages: [
        {
          role: 'user',
          content: input.prompt,
          ...(input.images?.some((item) => item.data)
            ? {
                images: input.images
                  .map((item) => item.data?.trim() ?? '')
                  .filter(Boolean),
              }
            : {}),
        },
      ],
      stream: false,
      options: {
        temperature: 0.2,
      },
    }),
    signal: AbortSignal.timeout(input.timeoutMs ?? 45000),
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
    throw new Error(data?.error || `ollama_http_${response.status}`)
  }

  const content = data?.message?.content?.trim()
  if (!content) {
    throw new Error('ollama_empty_response')
  }

  return {
    content,
  }
}

function parseOllamaKeyLine(line: string) {
  const separatorIndex = line.indexOf('=')
  if (separatorIndex > 0) {
    const name = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    if (name && value) {
      return { name, value } satisfies OllamaKeyEntry
    }
  }

  if (line) {
    return {
      name: `ollama-key-${Math.abs(hashLine(line))}`,
      value: line,
    } satisfies OllamaKeyEntry
  }

  return null
}

function hashLine(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index)
    hash |= 0
  }
  return hash
}

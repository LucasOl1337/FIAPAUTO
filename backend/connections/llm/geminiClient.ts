import fs from 'node:fs/promises'
import { runtimePaths } from '../../config/runtimePaths.ts'

export type GeminiKeyEntry = {
  name: string
  value: string
}

export async function postGeminiChat(input: {
  apiKey: string
  model: string
  prompt: string
  timeoutMs?: number
}) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(input.apiKey)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: input.prompt,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.3,
          topP: 0.9,
          maxOutputTokens: 700,
        },
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 45000),
    },
  )

  const data = (await response.json().catch(() => null)) as
    | {
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>
          }
          finishReason?: string
        }>
        error?: {
          code?: number
          message?: string
          status?: string
        }
      }
    | null

  if (!response.ok) {
    const message = data?.error?.message || `gemini_http_${response.status}`
    throw new Error(message)
  }

  const text =
    data?.candidates
      ?.flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('\n')
      .trim() ?? ''

  if (!text) {
    throw new Error(data?.candidates?.[0]?.finishReason || 'gemini_empty_response')
  }

  return {
    content: text,
  }
}

export async function readGeminiLocalKeys() {
  try {
    const raw = await fs.readFile(runtimePaths.geminiKeysLocalFile, 'utf-8')
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map(parseGeminiKeyLine)
      .filter((item): item is GeminiKeyEntry => Boolean(item))
  } catch {
    return []
  }
}

function parseGeminiKeyLine(line: string) {
  const separatorIndex = line.indexOf('=')
  if (separatorIndex > 0) {
    const name = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    if (name && value) {
      return { name, value } satisfies GeminiKeyEntry
    }
  }

  if (line) {
    return {
      name: `gemini-key-${Math.abs(hashLine(line))}`,
      value: line,
    } satisfies GeminiKeyEntry
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

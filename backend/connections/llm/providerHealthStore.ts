import path from 'node:path'
import { readJsonFile, writeJsonFile } from '../../database/fs.ts'
import { runtimePaths } from '../../config/runtimePaths.ts'

export type ProviderName = 'gemini' | 'ollama' | 'local'

export type ProviderKeyHealth = {
  keyName: string
  status: 'active' | 'limited' | 'failed' | 'cooldown'
  failCount: number
  successCount: number
  lastError?: string
  lastUsedAt?: string
  cooldownUntil?: string
}

export type ProviderHealth = {
  provider: ProviderName
  circuitOpenUntil?: string
  consecutiveFailures: number
  lastSuccessAt?: string
  lastError?: string
  keys: ProviderKeyHealth[]
}

type ProviderHealthState = {
  providers: ProviderHealth[]
}

const providerHealthFile = path.join(runtimePaths.logsDir, 'provider-health.json')
const defaultCooldownMs = Number(process.env.LLM_PROVIDER_COOLDOWN_MS ?? 120000)
const defaultCircuitMs = Number(process.env.LLM_PROVIDER_CIRCUIT_MS ?? 180000)

export async function readProviderHealthState() {
  return readJsonFile<ProviderHealthState>(providerHealthFile, { providers: [] })
}

export async function readProviderHealth(provider: ProviderName) {
  const state = await readProviderHealthState()
  return ensureProviderState(state, provider)
}

export async function markProviderAttempt(input: {
  provider: ProviderName
  keyName?: string
  success: boolean
  error?: string
  quotaLimited?: boolean
}) {
  const state = await readProviderHealthState()
  const providerState = ensureProviderState(state, input.provider)
  const now = new Date()
  const nowIso = now.toISOString()

  if (input.success) {
    providerState.consecutiveFailures = 0
    providerState.lastSuccessAt = nowIso
    providerState.lastError = undefined
    providerState.circuitOpenUntil = undefined

    if (input.keyName) {
      const keyState = ensureKeyState(providerState, input.keyName)
      keyState.status = 'active'
      keyState.successCount += 1
      keyState.lastUsedAt = nowIso
      keyState.lastError = undefined
      keyState.cooldownUntil = undefined
    }
  } else {
    providerState.consecutiveFailures += 1
    providerState.lastError = input.error

    if (providerState.consecutiveFailures >= 3) {
      providerState.circuitOpenUntil = new Date(now.getTime() + defaultCircuitMs).toISOString()
    }

    if (input.keyName) {
      const keyState = ensureKeyState(providerState, input.keyName)
      keyState.failCount += 1
      keyState.lastUsedAt = nowIso
      keyState.lastError = input.error
      if (input.quotaLimited) {
        keyState.status = 'limited'
        keyState.cooldownUntil = new Date(now.getTime() + defaultCooldownMs).toISOString()
      } else {
        keyState.status = 'failed'
      }
    }
  }

  await writeJsonFile(providerHealthFile, state)
}

export function isProviderCircuitOpen(state: ProviderHealth, now = new Date()) {
  if (!state.circuitOpenUntil) {
    return false
  }

  if (hasUsableProviderKey(state, now)) {
    return false
  }

  return new Date(state.circuitOpenUntil).getTime() > now.getTime()
}

export function isKeyCoolingDown(key: ProviderKeyHealth, now = new Date()) {
  if (!key.cooldownUntil) {
    return false
  }

  return new Date(key.cooldownUntil).getTime() > now.getTime()
}

export function hasUsableProviderKey(state: ProviderHealth, now = new Date()) {
  return state.keys.some((key) => isKeyUsable(key, now))
}

export function isKeyUsable(key: ProviderKeyHealth, now = new Date()) {
  if (isKeyCoolingDown(key, now)) {
    return false
  }

  return key.status === 'active'
}

function ensureProviderState(state: ProviderHealthState, provider: ProviderName) {
  const existing = state.providers.find((item) => item.provider === provider)
  if (existing) {
    return existing
  }

  const created: ProviderHealth = {
    provider,
    consecutiveFailures: 0,
    keys: [],
  }
  state.providers.push(created)
  return created
}

function ensureKeyState(providerState: ProviderHealth, keyName: string) {
  const existing = providerState.keys.find((item) => item.keyName === keyName)
  if (existing) {
    return existing
  }

  const created: ProviderKeyHealth = {
    keyName,
    status: 'active',
    failCount: 0,
    successCount: 0,
  }
  providerState.keys.push(created)
  return created
}

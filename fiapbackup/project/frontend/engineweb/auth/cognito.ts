import { resolvePublicApiBase } from '../publicApiBase.ts'

type PublicAuthMode = 'local' | 'none'

const authMode = normalizeAuthMode(import.meta.env.VITE_PUBLIC_AUTH_MODE)
const LOCAL_AUTH_SESSION_KEY = 'fiapauto.publicAuth.session'
const LOCAL_AUTH_TOKEN_KEY = 'fiapauto.publicAuth.token'

export function getPublicAuthMode(): PublicAuthMode {
  return authMode
}

export function isAuthRequired() {
  return authMode !== 'none'
}

export function isCognitoConfigured() {
  return false
}

export function configureCognito() {
  return
}

export async function getAccessToken() {
  return ''
}

export async function getSignedInUserLabel() {
  const token = readLocalAuthToken()
  if (!token) {
    return readLocalSession()?.email ?? ''
  }

  try {
    const session = await requestLocalAuth<{ userLabel: string; email?: string; token: string; isGuest: boolean }>('/api/public/auth/me', {
      method: 'GET',
      token,
    })
    writeLocalSession({ email: session.email || session.userLabel, userLabel: session.userLabel, isGuest: session.isGuest })
    return session.userLabel
  } catch {
    clearLocalSession()
    clearLocalAuthToken()
    return ''
  }
}

export async function signInWithPassword(username: string, password: string) {
  const session = await requestLocalAuth<{ token: string; userLabel: string; isGuest: boolean; email?: string }>('/api/public/auth/sign-in', {
    method: 'POST',
    body: { email: username, password },
  })
  writeLocalAuthToken(session.token)
  writeLocalSession({ email: session.email || session.userLabel, userLabel: session.userLabel, isGuest: session.isGuest })
  return { nextStep: { signInStep: 'DONE' } }
}

export async function signUpWithPassword(input: {
  email: string
  password: string
}) {
  const session = await requestLocalAuth<{ token: string; userLabel: string; isGuest: boolean; email?: string }>('/api/public/auth/sign-up', {
    method: 'POST',
    body: input,
  })
  writeLocalAuthToken(session.token)
  writeLocalSession({ email: session.email || session.userLabel, userLabel: session.userLabel, isGuest: session.isGuest })
  return { isSignUpComplete: true }
}

export async function confirmUserSignUp(input: {
  email: string
  code: string
}) {
  return {
    isSignUpComplete: true,
    nextStep: { signUpStep: 'DONE' },
    email: input.email,
    code: input.code,
  }
}

export async function resendUserConfirmationCode(email: string) {
  return { destination: email }
}

export async function signOutCurrentUser() {
  const token = readLocalAuthToken()
  if (token) {
    try {
      await requestLocalAuth('/api/public/auth/sign-out', {
        method: 'POST',
        token,
      })
    } catch {
      // Best effort.
    }
  }

  clearLocalSession()
  clearLocalAuthToken()
}

function normalizeAuthMode(value: string | undefined): PublicAuthMode {
  if (value === 'none') {
    return 'none'
  }

  return 'local'
}

function readLocalSession() {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const raw = window.localStorage.getItem(LOCAL_AUTH_SESSION_KEY)
    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as { email?: string; userLabel?: string; isGuest?: boolean }
    return parsed.userLabel ? { email: parsed.email ?? '', userLabel: parsed.userLabel, isGuest: Boolean(parsed.isGuest) } : null
  } catch {
    return null
  }
}

function writeLocalSession(session: { email: string; userLabel: string; isGuest: boolean }) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(LOCAL_AUTH_SESSION_KEY, JSON.stringify(session))
}

function clearLocalSession() {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.removeItem(LOCAL_AUTH_SESSION_KEY)
}

export async function signInAsVisitor() {
  const session = await requestLocalAuth<{ token: string; userLabel: string; isGuest: boolean; email?: string }>('/api/public/auth/guest', {
    method: 'POST',
  })
  writeLocalAuthToken(session.token)
  writeLocalSession({ email: session.email || session.userLabel, userLabel: session.userLabel, isGuest: session.isGuest })
  return session.userLabel
}

export async function pingCurrentUserActivity() {
  const token = readLocalAuthToken()
  if (!token) {
    return
  }

  try {
    await requestLocalAuth('/api/public/auth/ping', {
      method: 'POST',
      token,
    })
  } catch {
    // Ignore heartbeat failures.
  }
}

function readLocalAuthToken() {
  if (typeof window === 'undefined') {
    return ''
  }

  return window.localStorage.getItem(LOCAL_AUTH_TOKEN_KEY) ?? ''
}

function writeLocalAuthToken(token: string) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(LOCAL_AUTH_TOKEN_KEY, token)
}

function clearLocalAuthToken() {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.removeItem(LOCAL_AUTH_TOKEN_KEY)
}

async function requestLocalAuth<T = unknown>(
  path: string,
  input: {
    method: 'GET' | 'POST'
    body?: unknown
    token?: string
  },
) {
  const headers = new Headers({
    'Content-Type': 'application/json',
  })
  if (input.token) {
    headers.set('Authorization', `Bearer ${input.token}`)
  }

  const response = await fetch(`${resolvePublicApiBase()}${path}`, {
    method: input.method,
    headers,
    body: input.body ? JSON.stringify(input.body) : undefined,
  })

  if (!response.ok) {
    let errorCode = 'public_auth_request_failed'
    try {
      const payload = (await response.json()) as { error?: string }
      if (payload.error) {
        errorCode = payload.error
      }
    } catch {
      // Keep default.
    }
    throw new Error(errorCode)
  }

  return (await response.json()) as T
}

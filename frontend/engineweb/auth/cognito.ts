import { Amplify } from 'aws-amplify'
import { fetchAuthSession, getCurrentUser, signIn, signOut, signUp } from 'aws-amplify/auth'

type PublicAuthMode = 'local' | 'cognito' | 'none'

const cognitoConfig = {
  region: import.meta.env.VITE_COGNITO_REGION ?? '',
  userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID ?? '',
  userPoolClientId: import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID ?? '',
}

const configuredAuthMode = normalizeAuthMode(import.meta.env.VITE_PUBLIC_AUTH_MODE)
const authMode = configuredAuthMode === 'cognito' && isCognitoConfigComplete() ? 'cognito' : configuredAuthMode

const LOCAL_AUTH_SESSION_KEY = 'fiapauto.publicAuth.session'
const LOCAL_AUTH_TOKEN_KEY = 'fiapauto.publicAuth.token'
const PUBLIC_API_TUNNEL = 'https://exhibitions-sale-divide-dir.trycloudflare.com'

let configured = false

export function getPublicAuthMode(): PublicAuthMode {
  return authMode
}

export function isAuthRequired() {
  return authMode !== 'none'
}

export function isCognitoConfigured() {
  return authMode === 'cognito'
}

export function configureCognito() {
  if (configured || authMode !== 'cognito') {
    return
  }

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: cognitoConfig.userPoolId,
        userPoolClientId: cognitoConfig.userPoolClientId,
      },
    },
  })

  configured = true
}

export async function getAccessToken() {
  if (authMode !== 'cognito') {
    return ''
  }

  configureCognito()
  const session = await fetchAuthSession()
  return session.tokens?.accessToken?.toString() ?? ''
}

export async function getSignedInUserLabel() {
  if (authMode === 'local') {
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

  if (authMode !== 'cognito') {
    return ''
  }

  configureCognito()
  const user = await getCurrentUser()
  return user.signInDetails?.loginId ?? user.username
}

export async function signInWithPassword(username: string, password: string) {
  if (authMode === 'local') {
    const session = await requestLocalAuth<{ token: string; userLabel: string; isGuest: boolean; email?: string }>('/api/public/auth/sign-in', {
      method: 'POST',
      body: { email: username, password },
    })
    writeLocalAuthToken(session.token)
    writeLocalSession({ email: session.email || session.userLabel, userLabel: session.userLabel, isGuest: session.isGuest })
    return { nextStep: { signInStep: 'DONE' } }
  }

  configureCognito()
  return signIn({
    username,
    password,
  })
}

export async function signUpWithPassword(input: {
  email: string
  password: string
}) {
  if (authMode === 'local') {
    const session = await requestLocalAuth<{ token: string; userLabel: string; isGuest: boolean; email?: string }>('/api/public/auth/sign-up', {
      method: 'POST',
      body: input,
    })
    writeLocalAuthToken(session.token)
    writeLocalSession({ email: session.email || session.userLabel, userLabel: session.userLabel, isGuest: session.isGuest })
    return { isSignUpComplete: true }
  }

  configureCognito()
  return signUp({
    username: input.email,
    password: input.password,
    options: {
      userAttributes: {
        email: input.email,
      },
      autoSignIn: true,
    },
  })
}

export async function confirmUserSignUp(input: {
  email: string
  code: string
}) {
  if (authMode === 'local') {
    return {
      isSignUpComplete: true,
      nextStep: { signUpStep: 'DONE' },
      email: input.email,
      code: input.code,
    }
  }

  throw new Error('cognito_confirmation_disabled_in_temporary_mode')
}

export async function resendUserConfirmationCode(email: string) {
  if (authMode === 'local') {
    return { destination: email }
  }

  throw new Error('cognito_confirmation_disabled_in_temporary_mode')
}

export async function signOutCurrentUser() {
  if (authMode === 'local') {
    const token = readLocalAuthToken()
    if (token) {
      try {
        await requestLocalAuth('/api/public/auth/sign-out', {
          method: 'POST',
          token,
        })
      } catch {
        // Best effort only; local session cleanup still proceeds.
      }
    }
    clearLocalSession()
    clearLocalAuthToken()
    return
  }

  if (authMode !== 'cognito') {
    return
  }

  configureCognito()
  await signOut()
}

function isCognitoConfigComplete() {
  return Boolean(cognitoConfig.region && cognitoConfig.userPoolId && cognitoConfig.userPoolClientId)
}

function normalizeAuthMode(value: string | undefined): PublicAuthMode {
  if (value === 'cognito' || value === 'none') {
    return value
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
  if (authMode !== 'local') {
    throw new Error('visitor_mode_only_available_in_local_auth')
  }

  const session = await requestLocalAuth<{ token: string; userLabel: string; isGuest: boolean; email?: string }>('/api/public/auth/guest', {
    method: 'POST',
  })
  writeLocalAuthToken(session.token)
  writeLocalSession({ email: session.email || session.userLabel, userLabel: session.userLabel, isGuest: session.isGuest })
  return session.userLabel
}

export async function pingCurrentUserActivity() {
  if (authMode !== 'local') {
    return
  }

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
    // Ignore heartbeat failures; the visible session can recover on next page load.
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
      // Keep default error code when the body isn't JSON.
    }
    throw new Error(errorCode)
  }

  return (await response.json()) as T
}

function resolvePublicApiBase() {
  const explicitCandidates = [
    import.meta.env.VITE_PUBLIC_API_BASE_URL,
    import.meta.env.VITE_API_BASE_URL,
  ]
    .map((value) => value?.trim() ?? '')
    .filter(Boolean)

  const explicitBase = explicitCandidates.find((value) => !shouldIgnoreExplicitApiBase(value))
  return (explicitBase || PUBLIC_API_TUNNEL).replace(/\/+$/, '')
}

function shouldIgnoreExplicitApiBase(value: string) {
  try {
    const hostname = new URL(value).hostname
    const currentHostname = typeof window === 'undefined' ? '' : window.location.hostname
    return /^(127\.0\.0\.1|localhost)$/i.test(hostname) && !/^(127\.0\.0\.1|localhost)$/i.test(currentHostname)
  } catch {
    return false
  }
}

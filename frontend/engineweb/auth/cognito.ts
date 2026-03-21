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

const LOCAL_AUTH_USERS_KEY = 'fiapauto.publicAuth.users'
const LOCAL_AUTH_SESSION_KEY = 'fiapauto.publicAuth.session'

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
    return readLocalSession()?.email ?? ''
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
    const normalizedEmail = normalizeEmail(username)
    const user = readLocalUsers().find((entry) => entry.email === normalizedEmail && entry.password === password)
    if (!user) {
      throw new Error('local_auth_invalid_credentials')
    }

    writeLocalSession({ email: user.email })
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
    const normalizedEmail = normalizeEmail(input.email)
    if (!normalizedEmail || input.password.trim().length < 4) {
      throw new Error('local_auth_invalid_signup')
    }

    const users = readLocalUsers()
    if (users.some((entry) => entry.email === normalizedEmail)) {
      throw new Error('local_auth_user_exists')
    }

    users.push({
      email: normalizedEmail,
      password: input.password,
      createdAt: new Date().toISOString(),
    })

    writeLocalUsers(users)
    writeLocalSession({ email: normalizedEmail })
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
    clearLocalSession()
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

function normalizeEmail(value: string) {
  return value.trim().toLowerCase()
}

function readLocalUsers() {
  if (typeof window === 'undefined') {
    return [] as Array<{ email: string; password: string; createdAt: string }>
  }

  try {
    const raw = window.localStorage.getItem(LOCAL_AUTH_USERS_KEY)
    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw) as Array<{ email: string; password: string; createdAt: string }>
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeLocalUsers(users: Array<{ email: string; password: string; createdAt: string }>) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(LOCAL_AUTH_USERS_KEY, JSON.stringify(users))
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

    const parsed = JSON.parse(raw) as { email?: string }
    return parsed.email ? { email: parsed.email } : null
  } catch {
    return null
  }
}

function writeLocalSession(session: { email: string }) {
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

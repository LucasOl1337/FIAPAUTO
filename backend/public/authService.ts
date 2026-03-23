import crypto from 'node:crypto'
import { runtimePaths } from '../config/runtimePaths.ts'
import { readJsonFile, writeJsonFile } from '../database/fs.ts'

type PublicAuthUser = {
  id: string
  email: string
  password: string
  createdAt: string
  updatedAt: string
  lastLoginAt?: string
  lastSeenAt?: string
  signInCount: number
  totalActiveSeconds: number
}

type PublicAuthSession = {
  token: string
  userId: string | null
  email?: string
  label: string
  isGuest: boolean
  createdAt: string
  updatedAt: string
  lastSeenAt: string
  closedAt?: string
  totalActiveSeconds: number
}

type PublicAuthState = {
  users: PublicAuthUser[]
  sessions: PublicAuthSession[]
}

const ACTIVE_DELTA_CAP_SECONDS = 120

export type PublicAuthStore = {
  signUp: (input: { email: string; password: string }) => Promise<{ token: string; userLabel: string; isGuest: boolean }>
  signIn: (input: { email: string; password: string }) => Promise<{ token: string; userLabel: string; isGuest: boolean }>
  signInGuest: () => Promise<{ token: string; userLabel: string; isGuest: boolean }>
  readSession: (token: string) => Promise<{ token: string; userLabel: string; isGuest: boolean; email: string } | null>
  touchSession: (token: string) => Promise<{ ok: boolean }>
  signOutSession: (token: string) => Promise<{ ok: boolean }>
  listUsers: () => Promise<Array<{
    id: string
    email: string
    password: string
    createdAt: string
    updatedAt: string
    lastLoginAt?: string
    lastSeenAt?: string
    signInCount: number
    totalActiveSeconds: number
    activeSessions: number
  }>>
}

export function createPublicAuthStore(): PublicAuthStore {
  return {
    signUp: signUpWithLocalStore,
    signIn: signInWithLocalStore,
    signInGuest: signInGuestWithLocalStore,
    readSession: readSessionFromLocalStore,
    touchSession: touchSessionInLocalStore,
    signOutSession: signOutSessionFromLocalStore,
    listUsers: listUsersFromLocalStore,
  }
}

async function readState(): Promise<PublicAuthState> {
  const [users, sessions] = await Promise.all([
    readJsonFile<PublicAuthUser[]>(runtimePaths.publicAuthUsersFile, []),
    readJsonFile<PublicAuthSession[]>(runtimePaths.publicAuthSessionsFile, []),
  ])

  return {
    users: Array.isArray(users) ? users : [],
    sessions: Array.isArray(sessions) ? sessions : [],
  }
}

async function writeState(state: PublicAuthState) {
  await Promise.all([
    writeJsonFile(runtimePaths.publicAuthUsersFile, state.users),
    writeJsonFile(runtimePaths.publicAuthSessionsFile, state.sessions),
  ])
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase()
}

function buildGuestLabel() {
  const code = crypto.randomBytes(2).toString('hex')
  return `Visitante ${code}`
}

function createSession(input: { userId: string | null; email?: string; label: string; isGuest: boolean }) {
  const now = new Date().toISOString()
  return {
    token: crypto.randomBytes(24).toString('hex'),
    userId: input.userId,
    email: input.email,
    label: input.label,
    isGuest: input.isGuest,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    totalActiveSeconds: 0,
  } satisfies PublicAuthSession
}

function touchSessionAndUser(state: PublicAuthState, session: PublicAuthSession) {
  const now = new Date()
  const lastSeen = new Date(session.lastSeenAt)
  const elapsedSeconds = Number.isFinite(lastSeen.getTime())
    ? Math.max(0, Math.min(ACTIVE_DELTA_CAP_SECONDS, Math.floor((now.getTime() - lastSeen.getTime()) / 1000)))
    : 0

  session.totalActiveSeconds += elapsedSeconds
  session.lastSeenAt = now.toISOString()
  session.updatedAt = session.lastSeenAt

  if (!session.isGuest && session.userId) {
    const user = state.users.find((entry) => entry.id === session.userId)
    if (user) {
      user.totalActiveSeconds += elapsedSeconds
      user.lastSeenAt = session.lastSeenAt
      user.updatedAt = session.updatedAt
    }
  }
}

export async function signUpPublicUser(input: { email: string; password: string }) {
  return createPublicAuthStore().signUp(input)
}

async function signUpWithLocalStore(input: { email: string; password: string }) {
  const email = normalizeEmail(input.email)
  const password = input.password.trim()
  if (!email || password.length < 4) {
    throw new Error('public_auth_invalid_signup')
  }

  const state = await readState()
  if (state.users.some((entry) => entry.email === email)) {
    throw new Error('public_auth_user_exists')
  }

  const now = new Date().toISOString()
  const user: PublicAuthUser = {
    id: crypto.randomUUID(),
    email,
    password,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now,
    lastSeenAt: now,
    signInCount: 1,
    totalActiveSeconds: 0,
  }
  const session = createSession({
    userId: user.id,
    email: user.email,
    label: user.email,
    isGuest: false,
  })

  state.users.push(user)
  state.sessions.unshift(session)
  await writeState(state)

  return {
    token: session.token,
    userLabel: session.label,
    isGuest: false,
  }
}

export async function signInPublicUser(input: { email: string; password: string }) {
  return createPublicAuthStore().signIn(input)
}

async function signInWithLocalStore(input: { email: string; password: string }) {
  const email = normalizeEmail(input.email)
  const password = input.password
  const state = await readState()
  const user = state.users.find((entry) => entry.email === email && entry.password === password)
  if (!user) {
    throw new Error('public_auth_invalid_credentials')
  }

  const now = new Date().toISOString()
  user.lastLoginAt = now
  user.lastSeenAt = now
  user.updatedAt = now
  user.signInCount += 1

  const session = createSession({
    userId: user.id,
    email: user.email,
    label: user.email,
    isGuest: false,
  })
  state.sessions.unshift(session)
  await writeState(state)

  return {
    token: session.token,
    userLabel: session.label,
    isGuest: false,
  }
}

export async function signInPublicGuest() {
  return createPublicAuthStore().signInGuest()
}

async function signInGuestWithLocalStore() {
  const state = await readState()
  const session = createSession({
    userId: null,
    label: buildGuestLabel(),
    isGuest: true,
  })
  state.sessions.unshift(session)
  await writeState(state)

  return {
    token: session.token,
    userLabel: session.label,
    isGuest: true,
  }
}

export async function readPublicSession(token: string) {
  return createPublicAuthStore().readSession(token)
}

async function readSessionFromLocalStore(token: string) {
  const normalizedToken = token.trim()
  if (!normalizedToken) {
    return null
  }

  const state = await readState()
  const session = state.sessions.find((entry) => entry.token === normalizedToken && !entry.closedAt)
  if (!session) {
    return null
  }

  touchSessionAndUser(state, session)
  await writeState(state)

  return {
    token: session.token,
    userLabel: session.label,
    isGuest: session.isGuest,
    email: session.email ?? '',
  }
}

export async function touchPublicSession(token: string) {
  return createPublicAuthStore().touchSession(token)
}

async function touchSessionInLocalStore(token: string) {
  const normalizedToken = token.trim()
  if (!normalizedToken) {
    return { ok: false }
  }

  const state = await readState()
  const session = state.sessions.find((entry) => entry.token === normalizedToken && !entry.closedAt)
  if (!session) {
    return { ok: false }
  }

  touchSessionAndUser(state, session)
  await writeState(state)
  return { ok: true }
}

export async function signOutPublicSession(token: string) {
  return createPublicAuthStore().signOutSession(token)
}

async function signOutSessionFromLocalStore(token: string) {
  const normalizedToken = token.trim()
  if (!normalizedToken) {
    return { ok: true }
  }

  const state = await readState()
  const session = state.sessions.find((entry) => entry.token === normalizedToken && !entry.closedAt)
  if (!session) {
    return { ok: true }
  }

  touchSessionAndUser(state, session)
  session.closedAt = new Date().toISOString()
  session.updatedAt = session.closedAt
  await writeState(state)
  return { ok: true }
}

export async function listPublicUsersForAdmin() {
  return createPublicAuthStore().listUsers()
}

async function listUsersFromLocalStore() {
  const state = await readState()

  return state.users.map((user) => {
    const activeSessions = state.sessions.filter((session) => session.userId === user.id && !session.closedAt).length
    return {
      id: user.id,
      email: user.email,
      password: user.password,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt,
      lastSeenAt: user.lastSeenAt,
      signInCount: user.signInCount,
      totalActiveSeconds: user.totalActiveSeconds,
      activeSessions,
    }
  })
}

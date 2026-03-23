import { defaultCommunitySnapshot } from './data.ts'
import type { CommunitySnapshot, CommunityViewer } from './types.ts'

const COMMUNITY_STORAGE_KEY = 'fiapauto.community.snapshot.v2'
const COMMUNITY_VISITOR_KEY = 'fiapauto.community.visitor'

export function loadCommunitySnapshot(): CommunitySnapshot {
  if (typeof window === 'undefined') {
    return sortSnapshot(defaultCommunitySnapshot)
  }

  try {
    const raw = window.localStorage.getItem(COMMUNITY_STORAGE_KEY)
    if (!raw) {
      return sortSnapshot(defaultCommunitySnapshot)
    }

    const parsed = JSON.parse(raw) as Partial<CommunitySnapshot>
    return sortSnapshot({
      ideas: Array.isArray(parsed.ideas) ? parsed.ideas : defaultCommunitySnapshot.ideas,
      votes: Array.isArray(parsed.votes) ? parsed.votes : defaultCommunitySnapshot.votes,
      patchNotes: Array.isArray(parsed.patchNotes) ? parsed.patchNotes : defaultCommunitySnapshot.patchNotes,
      roadmapItems: Array.isArray(parsed.roadmapItems) ? parsed.roadmapItems : defaultCommunitySnapshot.roadmapItems,
    })
  } catch {
    return sortSnapshot(defaultCommunitySnapshot)
  }
}

export function saveCommunitySnapshot(snapshot: CommunitySnapshot) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(COMMUNITY_STORAGE_KEY, JSON.stringify(snapshot))
}

export function subscribeCommunitySnapshot(listener: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === COMMUNITY_STORAGE_KEY) {
      listener()
    }
  }

  window.addEventListener('storage', handleStorage)
  return () => window.removeEventListener('storage', handleStorage)
}

export function getAnonymousCommunityViewer(): CommunityViewer {
  const fallbackId = 'visitor-lab'
  if (typeof window === 'undefined') {
    return {
      userId: fallbackId,
      userLabel: 'Anonimo',
      isGuest: true,
      canParticipate: true,
      source: 'anonymous',
    }
  }

  const existing = window.localStorage.getItem(COMMUNITY_VISITOR_KEY)
  if (existing) {
    return {
      userId: existing,
      userLabel: 'Anonimo',
      isGuest: true,
      canParticipate: true,
      source: 'anonymous',
    }
  }

  const generated = buildVisitorId()
  window.localStorage.setItem(COMMUNITY_VISITOR_KEY, generated)
  return {
    userId: generated,
    userLabel: 'Anonimo',
    isGuest: true,
    canParticipate: true,
    source: 'anonymous',
  }
}

function sortSnapshot(snapshot: CommunitySnapshot): CommunitySnapshot {
  return {
    ...snapshot,
    patchNotes: [...snapshot.patchNotes].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    roadmapItems: [...snapshot.roadmapItems].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    ideas: [...snapshot.ideas].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  }
}

function buildVisitorId() {
  const parts = [
    typeof navigator !== 'undefined' ? navigator.userAgent : 'ua',
    typeof navigator !== 'undefined' ? navigator.language : 'lang',
    typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'tz',
    typeof screen !== 'undefined' ? `${screen.width}x${screen.height}` : 'screen',
  ].join('|')

  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.round(Math.random() * 10000)}`

  return `visitor-${simpleHash(parts)}-${random.slice(0, 8)}`
}

function simpleHash(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index)
    hash |= 0
  }

  return Math.abs(hash).toString(36)
}

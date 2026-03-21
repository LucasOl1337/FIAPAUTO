import { initialWorkspaceState } from './demoData'
import type { WorkspaceState } from '../types'

const STORAGE_KEY = 'fiapauto.workspace.v1'

export function loadWorkspaceState(): WorkspaceState {
  const raw = localStorage.getItem(STORAGE_KEY)

  if (!raw) {
    return initialWorkspaceState
  }

  try {
    const parsed = JSON.parse(raw) as WorkspaceState

    return {
      lessons: parsed.lessons ?? [],
      transcripts: parsed.transcripts ?? [],
      summaries: parsed.summaries ?? [],
      fragilities: parsed.fragilities ?? [],
      materials: parsed.materials ?? [],
    }
  } catch {
    return initialWorkspaceState
  }
}

export function saveWorkspaceState(state: WorkspaceState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function resetWorkspaceState() {
  localStorage.removeItem(STORAGE_KEY)
  return initialWorkspaceState
}

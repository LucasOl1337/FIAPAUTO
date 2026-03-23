import { useEffect, useMemo, useState } from 'react'
import { loadCommunitySnapshot, saveCommunitySnapshot, subscribeCommunitySnapshot } from './storage.ts'
import type {
  CommunityIdea,
  CommunityIdeaView,
  CommunitySnapshot,
  CommunityViewer,
  SubmitIdeaInput,
  VoteValue,
} from './types.ts'

export function useCommunityState(viewer: CommunityViewer) {
  const [snapshot, setSnapshot] = useState<CommunitySnapshot>(() => loadCommunitySnapshot())

  useEffect(() => {
    saveCommunitySnapshot(snapshot)
  }, [snapshot])

  useEffect(() => subscribeCommunitySnapshot(() => setSnapshot(loadCommunitySnapshot())), [])

  const ideas = useMemo(
    () => buildIdeaViews(snapshot, viewer.userId),
    [snapshot, viewer.userId],
  )

  const stats = useMemo(
    () => ({
      ideaCount: snapshot.ideas.length,
      patchCount: snapshot.patchNotes.length,
      roadmapCount: snapshot.roadmapItems.length,
      plannedCount: snapshot.roadmapItems.filter((item) => item.status === 'em desenvolvimento' || item.status === 'planejado').length,
    }),
    [snapshot],
  )

  function submitIdea(input: SubmitIdeaInput) {
    if (!viewer.canParticipate || !viewer.userId) {
      return { ok: false as const, message: 'Nao foi possivel identificar este visitante agora.' }
    }

    const title = input.title.trim()
    const description = input.description.trim()

    if (!title || !description) {
      return { ok: false as const, message: 'Preencha titulo e descricao antes de enviar.' }
    }

    const nextIdea: CommunityIdea = {
      id: buildId('idea'),
      title,
      description,
      category: undefined,
      authorId: viewer.userId,
      authorLabel: viewer.userLabel || (viewer.source === 'anonymous' ? 'Anonimo' : 'Membro FiapFlow'),
      status: 'nova',
      createdAt: new Date().toISOString(),
    }

    setSnapshot((current) => ({
      ...current,
      ideas: [nextIdea, ...current.ideas],
    }))

    return { ok: true as const, message: 'Ideia enviada para o mural da comunidade.' }
  }

  function voteOnIdea(ideaId: string, direction: VoteValue) {
    const viewerId = viewer.userId
    if (!viewer.canParticipate || !viewerId) {
      return { ok: false as const, message: 'Nao foi possivel identificar este visitante agora.' }
    }

    setSnapshot((current) => {
      const existingVote = current.votes.find((vote) => vote.ideaId === ideaId && vote.userId === viewerId)
      const nextVotes = current.votes.filter((vote) => !(vote.ideaId === ideaId && vote.userId === viewerId))

      if (!existingVote || existingVote.value !== direction) {
        nextVotes.push({
          id: existingVote?.id ?? buildId('vote'),
          userId: viewerId,
          ideaId,
          value: direction,
        })
      }

      const nextIdeas = current.ideas.filter((idea) => {
        if (idea.id !== ideaId) {
          return true
        }

        const score = nextVotes
          .filter((vote) => vote.ideaId === ideaId)
          .reduce((total, vote) => total + vote.value, 0)
        return score > -1
      })

      const validIdeaIds = new Set(nextIdeas.map((idea) => idea.id))
      const cleanedVotes = nextVotes.filter((vote) => validIdeaIds.has(vote.ideaId))

      return {
        ...current,
        ideas: nextIdeas,
        votes: cleanedVotes,
      }
    })

    return { ok: true as const, message: 'Voto atualizado.' }
  }

  return {
    ideas,
    patchNotes: snapshot.patchNotes,
    roadmapItems: snapshot.roadmapItems,
    stats,
    submitIdea,
    voteOnIdea,
  }
}

function buildIdeaViews(snapshot: CommunitySnapshot, userId: string | null): CommunityIdeaView[] {
  return snapshot.ideas
    .map((idea) => {
      const relatedVotes = snapshot.votes.filter((vote) => vote.ideaId === idea.id)
      const upvotes = relatedVotes.filter((vote) => vote.value === 1).length
      const downvotes = relatedVotes.filter((vote) => vote.value === -1).length
      const userVote = (relatedVotes.find((vote) => vote.userId === userId)?.value ?? 0) as VoteValue | 0

      return {
        ...idea,
        upvotes,
        downvotes,
        score: upvotes - downvotes,
        userVote,
      }
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }

      return right.createdAt.localeCompare(left.createdAt)
    })
}

function buildId(prefix: string) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`
  }

  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 10000)}`
}

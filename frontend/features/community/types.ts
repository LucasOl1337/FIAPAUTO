export type PatchNoteType = 'novo' | 'melhoria' | 'fix'

export type RoadmapStatus = 'planejado' | 'em analise' | 'em desenvolvimento' | 'concluido'

export type CommunityIdeaStatus = 'nova' | 'em analise' | 'planejada' | 'em desenvolvimento' | 'concluida'

export type VoteValue = -1 | 1

export interface PatchNote {
  id: string
  title: string
  description: string
  type: PatchNoteType
  createdAt: string
}

export interface RoadmapItem {
  id: string
  title: string
  description: string
  status: RoadmapStatus
  createdAt: string
}

export interface CommunityIdea {
  id: string
  title: string
  description: string
  category?: string
  authorId: string | null
  authorLabel: string
  status: CommunityIdeaStatus
  createdAt: string
}

export interface CommunityVote {
  id: string
  userId: string
  ideaId: string
  value: VoteValue
}

export interface CommunitySnapshot {
  ideas: CommunityIdea[]
  votes: CommunityVote[]
  patchNotes: PatchNote[]
  roadmapItems: RoadmapItem[]
}

export interface CommunityViewer {
  userId: string | null
  userLabel: string
  isGuest: boolean
  canParticipate: boolean
  source?: 'authenticated' | 'anonymous'
}

export interface CommunityIdeaView extends CommunityIdea {
  score: number
  upvotes: number
  downvotes: number
  userVote: VoteValue | 0
}

export interface SubmitIdeaInput {
  title: string
  description: string
}

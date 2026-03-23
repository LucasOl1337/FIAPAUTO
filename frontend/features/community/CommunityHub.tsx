import { useState, type ReactNode } from 'react'
import './CommunityHub.css'
import { useCommunityState } from './useCommunityState.ts'
import type {
  CommunityIdeaStatus,
  CommunityIdeaView,
  CommunityViewer,
  PatchNote,
  PatchNoteType,
  RoadmapItem,
  RoadmapStatus,
  VoteValue,
} from './types.ts'

type CommunityHubProps = {
  viewer: CommunityViewer
  layout?: 'login' | 'app'
}

export function CommunityHub({ viewer, layout = 'app' }: CommunityHubProps) {
  const { ideas, patchNotes, roadmapItems, stats, submitIdea, voteOnIdea } = useCommunityState(viewer)

  return (
    <section className={layout === 'login' ? 'community-shell login' : 'community-shell app'}>
      <div className="community-main-column">
        <CommunityCard
          eyebrow="Comunidade"
          title="Mural de ideias"
          subtitle="Colete votos da comunidade, acompanhe sugestoes aprovadas e publique novas propostas sem duplicar a logica da pagina interna."
        >
          <div className="community-kpi-row">
            <CommunityStat label="Ideias abertas" value={stats.ideaCount} />
            <CommunityStat label="Patch notes" value={stats.patchCount} />
            <CommunityStat label="Itens em rota" value={stats.plannedCount} />
          </div>
        </CommunityCard>

        <IdeaForm
          viewer={viewer}
          onSubmit={submitIdea}
        />

        <IdeasFeed
          ideas={ideas}
          viewer={viewer}
          onVote={voteOnIdea}
        />
      </div>

      <div className="community-side-column">
        <PatchNotesList items={patchNotes} />
        <RoadmapList items={roadmapItems} total={stats.roadmapCount} />
      </div>
    </section>
  )
}

export function CommunityView(props: { viewer: CommunityViewer }) {
  return (
    <section className="panel-card community-view-header">
      <div className="community-card-copy">
        <p className="eyebrow">Comunidade</p>
        <h2>Roadmap vivo, releases e ideias com voto</h2>
        <p className="hero-text">
          Esta aba reaproveita a mesma estrutura da pagina publica para manter patch notes, roadmap e participacao da comunidade alinhados.
        </p>
      </div>
      <CommunityHub viewer={props.viewer} layout="app" />
    </section>
  )
}

export function IdeaForm(props: {
  viewer: CommunityViewer
  onSubmit: (input: { title: string; description: string }) => { ok: boolean; message: string }
  compact?: boolean
  className?: string
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [feedback, setFeedback] = useState('')
  const [open, setOpen] = useState(!props.compact)

  const disabledReason = props.viewer.canParticipate ? '' : 'Nao foi possivel identificar este visitante agora.'

  return (
    <CommunityCard
      eyebrow="Enviar Ideia"
      title="Sugira a proxima melhoria do FiapFlow"
      subtitle="Titulo e descricao."
      soft
      compact={props.compact}
      className={props.className}
    >
      {props.compact ? (
        <div className="community-bubble-row">
          <button
            type="button"
            className={open ? 'community-bubble-button active' : 'community-bubble-button'}
            onClick={() => setOpen((current) => !current)}
            aria-label="Abrir envio de ideia"
          >
            <span className="community-bubble-icon">+</span>
            <span>Nova ideia</span>
          </button>
          {feedback ? <span className="idea-form-helper">{feedback}</span> : null}
        </div>
      ) : null}
      {!open ? null : (
      <form
        className="community-form"
        onSubmit={(event) => {
          event.preventDefault()
          const result = props.onSubmit({ title, description })
          setFeedback(result.message)
          if (result.ok) {
            setTitle('')
            setDescription('')
            if (props.compact) {
              setOpen(false)
            }
          }
        }}
      >
        <div className="community-form-grid">
          <label className="community-field">
            <span className="community-field-label">Titulo</span>
          <input
            className="community-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={!props.viewer.canParticipate}
          />
          </label>
          <label className="community-field">
            <span className="community-field-label">Descricao</span>
          <textarea
            className="community-textarea"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={!props.viewer.canParticipate}
          />
          </label>
        </div>
        <div className="community-form-footer">
          <span className="idea-form-helper">{feedback || disabledReason || 'Ideias novas entram com status "nova".'}</span>
          <button type="submit" className="primary-button" disabled={!props.viewer.canParticipate}>
            Enviar ideia
          </button>
        </div>
      </form>
      )}
    </CommunityCard>
  )
}

export function IdeasFeed(props: {
  ideas: CommunityIdeaView[]
  viewer: CommunityViewer
  onVote: (ideaId: string, direction: VoteValue) => { ok: boolean; message: string }
  compact?: boolean
  limit?: number
  className?: string
}) {
  const voteHint = props.viewer.canParticipate
    ? 'Upvote e downvote liberados para visitantes no LAB.'
    : 'Votacao indisponivel neste momento.'

  const ideas = props.limit ? props.ideas.slice(0, props.limit) : props.ideas

  return (
    <CommunityCard
      eyebrow="Ideias da Comunidade"
      title="Feed aberto de sugestoes"
      subtitle={voteHint}
      compact={props.compact}
      className={props.className}
    >
      <div className={props.compact ? 'community-item-list compact scrollable' : 'community-item-list'}>
        {ideas.length > 0
          ? ideas.map((idea) => (
              <article key={idea.id} className={props.compact ? 'community-idea-item compact' : 'community-idea-item'}>
                <VoteButtons
                  score={idea.score}
                  userVote={idea.userVote}
                  disabled={!props.viewer.canParticipate}
                  compact={props.compact}
                  onVote={(direction) => {
                    props.onVote(idea.id, direction)
                  }}
                />
                <div className={props.compact ? 'community-idea-content compact' : 'community-idea-content'}>
                  <div className="idea-meta-row">
                    <span className={`community-chip ${ideaStatusClassName(idea.status)}`}>{idea.status}</span>
                    {idea.category ? <span className="community-chip">{idea.category}</span> : null}
                    <span className="community-item-meta">{formatDateOnly(idea.createdAt)}</span>
                  </div>
                  <h4>{idea.title}</h4>
                  <p>{idea.description}</p>
                  <div className="idea-meta-row">
                    <span className="community-item-meta">por {idea.authorLabel || 'Visitante'}</span>
                    <span className="community-item-meta">{idea.upvotes} upvotes</span>
                    <span className="community-item-meta">{idea.downvotes} downvotes</span>
                  </div>
                </div>
              </article>
            ))
          : <p className="community-empty">Nenhuma ideia publicada ainda.</p>}
      </div>
    </CommunityCard>
  )
}

export function VoteButtons(props: {
  score: number
  userVote: VoteValue | 0
  disabled: boolean
  onVote: (direction: VoteValue) => void
  compact?: boolean
}) {
  return (
    <div className={props.compact ? 'vote-stack compact' : 'vote-stack'}>
      <button
        type="button"
        className={props.userVote === 1 ? 'vote-button active up' : 'vote-button'}
        aria-label="Dar upvote"
        disabled={props.disabled}
        onClick={() => props.onVote(1)}
      >
        +
      </button>
      <strong className="vote-score">{props.score}</strong>
      <button
        type="button"
        className={props.userVote === -1 ? 'vote-button active down' : 'vote-button'}
        aria-label="Dar downvote"
        disabled={props.disabled}
        onClick={() => props.onVote(-1)}
      >
        -
      </button>
      <span className="vote-caption">score</span>
    </div>
  )
}

export function PatchNotesList(props: { items: PatchNote[] }) {
  return <PatchNotesListBase items={props.items} />
}

export function PatchNotesListBase(props: {
  items: PatchNote[]
  compact?: boolean
  limit?: number
  className?: string
}) {
  const items = props.limit ? props.items.slice(0, props.limit) : props.items

  return (
    <CommunityCard
      eyebrow="Patch Notes"
      title="Atualizacoes mais recentes"
      subtitle="Cards ordenados do release mais novo para o mais antigo."
      compact={props.compact}
      className={props.className}
    >
      <div className={props.compact ? 'community-item-list compact scrollable' : 'community-item-list'}>
        {items.map((item) => (
          <article key={item.id} className={props.compact ? 'community-note-item compact' : 'community-note-item'}>
            <div className="community-item-meta">
              <span className={`community-chip patch-${normalizeType(item.type)}`}>{item.type}</span>
              <span>{formatDateOnly(item.createdAt)}</span>
            </div>
            <h4>{item.title}</h4>
            <p>{item.description}</p>
          </article>
        ))}
      </div>
    </CommunityCard>
  )
}

export function RoadmapList(props: { items: RoadmapItem[]; total: number }) {
  return <RoadmapListBase items={props.items} total={props.total} />
}

export function RoadmapListBase(props: {
  items: RoadmapItem[]
  total: number
  compact?: boolean
  limit?: number
  className?: string
}) {
  const items = props.limit ? props.items.slice(0, props.limit) : props.items

  return (
    <CommunityCard
      eyebrow="Roadmap"
      title="Em desenvolvimento"
      subtitle={`${props.total} item(ns) mapeados para as proximas entregas do produto.`}
      soft
      compact={props.compact}
      className={props.className}
    >
      <div className={props.compact ? 'community-item-list compact scrollable' : 'community-item-list'}>
        {items.map((item) => (
          <article key={item.id} className={props.compact ? 'community-roadmap-item compact' : 'community-roadmap-item'}>
            <div className="community-item-meta">
              <span className={`community-chip status-${normalizeStatus(item.status)}`}>{item.status}</span>
              <span>{formatDateOnly(item.createdAt)}</span>
            </div>
            <h4>{item.title}</h4>
            <p>{item.description}</p>
          </article>
        ))}
      </div>
    </CommunityCard>
  )
}

export function CommunityCard(props: {
  eyebrow: string
  title: string
  subtitle: string
  soft?: boolean
  children: ReactNode
  compact?: boolean
  className?: string
}) {
  const className = [
    'community-card',
    props.soft ? 'soft' : '',
    props.compact ? 'compact' : '',
    props.className ?? '',
  ].filter(Boolean).join(' ')

  return (
    <section className={className}>
      <div className="community-card-header">
        <div className="community-card-copy">
          <p className="eyebrow">{props.eyebrow}</p>
          <h3>{props.title}</h3>
          <p className="community-meta-text">{props.subtitle}</p>
        </div>
      </div>
      {props.children}
    </section>
  )
}

function CommunityStat(props: { label: string; value: number }) {
  return (
    <div className="community-stat">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  )
}

function formatDateOnly(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(new Date(value))
}

function normalizeStatus(value: RoadmapStatus) {
  return value.replace(/\s+/g, '-')
}

function normalizeType(value: PatchNoteType) {
  return value
}

function ideaStatusClassName(value: CommunityIdeaStatus) {
  return `idea-${value.replace(/\s+/g, '-')}`
}

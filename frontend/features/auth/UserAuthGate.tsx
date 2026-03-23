import { useEffect, useState, type ReactNode } from 'react'
import {
  getCurrentPublicSession,
  getStoredPublicSession,
  isAuthRequired,
  pingCurrentUserActivity,
  signInAsVisitor,
  signInWithPassword,
  signUpWithPassword,
} from '../../engineweb/auth/cognito.ts'
import { IdeaForm, IdeasFeed, PatchNotesListBase, RoadmapListBase } from '../community/CommunityHub.tsx'
import { useCommunityState } from '../community/useCommunityState.ts'
import { getAnonymousCommunityViewer } from '../community/storage.ts'

type UserAuthGateProps = {
  children: (props: { userLabel: string; userId: string | null; isGuest: boolean }) => ReactNode
}

export function UserAuthGate({ children }: UserAuthGateProps) {
  const [userLabel, setUserLabel] = useState('')
  const [userId, setUserId] = useState<string | null>(null)
  const [isGuest, setIsGuest] = useState(false)
  const [mode, setMode] = useState<'sign_in' | 'sign_up'>('sign_in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(() => !isAuthRequired())
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (!isAuthRequired()) {
      return
    }

    void getCurrentPublicSession()
      .then((session) => {
        setUserLabel(session?.userLabel ?? '')
        setUserId(session?.userId ?? null)
        setIsGuest(Boolean(session?.isGuest))
      })
      .catch(() => {
        setUserLabel('')
        setUserId(null)
        setIsGuest(false)
      })
      .finally(() => setReady(true))
  }, [])

  useEffect(() => {
    if (!userLabel || !isAuthRequired()) {
      return
    }

    void pingCurrentUserActivity()
    const intervalId = window.setInterval(() => {
      void pingCurrentUserActivity()
    }, 30_000)

    return () => window.clearInterval(intervalId)
  }, [userLabel])

  if (!ready) {
    return (
      <main className="simple-app">
        <section className="hero-card">
          <p className="eyebrow">FiapFlow</p>
          <h1>Validando sessao do usuario</h1>
          <p className="hero-text">Estamos preparando seu acesso.</p>
        </section>
      </main>
    )
  }

  if (!isAuthRequired() || userLabel) {
    return <>{children({ userLabel, userId, isGuest })}</>
  }

  return (
    <PublicEntryScreen
      mode={mode}
      email={email}
      password={password}
      busy={busy}
      notice={notice}
      error={error}
      onEmailChange={setEmail}
      onPasswordChange={setPassword}
      onSignIn={() => {
        setBusy(true)
        setError('')
        setNotice('')
        void signInWithPassword(email, password)
          .then(() => {
            const session = getStoredPublicSession()
            setUserLabel(session?.userLabel ?? '')
            setUserId(session?.userId ?? null)
            setIsGuest(Boolean(session?.isGuest))
          })
          .catch(() => setError('Nao foi possivel autenticar com as credenciais informadas.'))
          .finally(() => setBusy(false))
      }}
      onGuestSignIn={() => {
        setBusy(true)
        setError('')
        setNotice('')
        void signInAsVisitor()
          .then(() => {
            const session = getStoredPublicSession()
            setNotice('Entrando como visitante.')
            setUserLabel(session?.userLabel ?? '')
            setUserId(session?.userId ?? null)
            setIsGuest(Boolean(session?.isGuest))
          })
          .catch(() => setError('Nao foi possivel abrir o portal como visitante agora.'))
          .finally(() => setBusy(false))
      }}
      onSignUp={() => {
        setBusy(true)
        setError('')
        setNotice('')
        void signUpWithPassword({ email, password })
          .then(() => {
            const session = getStoredPublicSession()
            setNotice('Conta criada com sucesso.')
            setUserLabel(session?.userLabel ?? '')
            setUserId(session?.userId ?? null)
            setIsGuest(Boolean(session?.isGuest))
          })
          .catch((signupError) => {
            const message = signupError instanceof Error ? signupError.message : ''
            if (message === 'public_auth_user_exists') {
              setError('Esse email ja foi cadastrado no portal. Tente entrar com a senha criada.')
              return
            }
            setError('Nao foi possivel criar a conta agora. Use um email valido e uma senha com pelo menos 4 caracteres.')
          })
          .finally(() => setBusy(false))
      }}
      onModeChange={(nextMode) => {
        setMode(nextMode)
        setError('')
        setNotice('')
      }}
    />
  )
}

function PublicEntryScreen(props: {
  mode: 'sign_in' | 'sign_up'
  email: string
  password: string
  busy: boolean
  notice: string
  error: string
  onEmailChange: (value: string) => void
  onPasswordChange: (value: string) => void
  onSignIn: () => void
  onGuestSignIn: () => void
  onSignUp: () => void
  onModeChange: (mode: 'sign_in' | 'sign_up') => void
}) {
  const viewer = getAnonymousCommunityViewer()
  const community = useCommunityState(viewer)

  return (
    <main className="simple-app auth-entry-screen">
      <section className="auth-entry-top-grid">
        <section className="hero-card auth-login-card">
          <div className="auth-login-panel">
          <p className="eyebrow">FiapFlow</p>
          <h1>{props.mode === 'sign_up' ? 'Criar conta no Assistente de Estudos' : 'Entrar no Assistente de Estudos'}</h1>
          <p className="hero-text">
            {props.mode === 'sign_up'
              ? 'Crie sua conta com email e senha para acessar o assistente.'
              : 'Use seu email e senha, ou entre como visitante.'}
          </p>
          <div className="admin-gate compact">
            <label className="admin-gate-label" htmlFor="user-email">Email</label>
            <input id="user-email" className="admin-gate-input" value={props.email} onChange={(event) => props.onEmailChange(event.target.value)} />
            <label className="admin-gate-label" htmlFor="user-password">Senha</label>
            <input id="user-password" className="admin-gate-input" type="password" value={props.password} onChange={(event) => props.onPasswordChange(event.target.value)} />
            {props.notice ? <p className="hero-text">{props.notice}</p> : null}
            {props.error ? <p className="hero-text">{props.error}</p> : null}
            <div className="action-row">
              {props.mode === 'sign_in' ? (
                <button type="button" className="primary-button" disabled={props.busy} onClick={props.onSignIn}>
                  {props.busy ? 'Entrando...' : 'Entrar'}
                </button>
              ) : null}
              {props.mode === 'sign_in' ? (
                <button type="button" className="secondary-button" disabled={props.busy} onClick={props.onGuestSignIn}>
                  {props.busy ? 'Abrindo...' : 'Entrar como visitante'}
                </button>
              ) : null}
              {props.mode === 'sign_up' ? (
                <button type="button" className="primary-button" disabled={props.busy} onClick={props.onSignUp}>
                  {props.busy ? 'Criando...' : 'Criar conta'}
                </button>
              ) : null}
              {props.mode !== 'sign_in' ? (
                <button type="button" className="secondary-button" disabled={props.busy} onClick={() => props.onModeChange('sign_in')}>
                  Ja tenho conta
                </button>
              ) : null}
              {props.mode === 'sign_in' ? (
                <button type="button" className="secondary-button" disabled={props.busy} onClick={() => props.onModeChange('sign_up')}>
                  Criar conta
                </button>
              ) : null}
            </div>
          </div>
          </div>
        </section>

        <PatchNotesListBase
          items={community.patchNotes}
          compact
          limit={2}
          className="entry-patch-panel"
        />
      </section>

      <section className="auth-entry-community-grid">
        <div className="auth-entry-left-column">
          <IdeaForm
            viewer={viewer}
            onSubmit={community.submitIdea}
            compact
            className="entry-idea-form"
          />
          <IdeasFeed
            ideas={community.ideas}
            viewer={viewer}
            onVote={community.voteOnIdea}
            compact
            limit={4}
            className="entry-ideas-feed"
          />
        </div>

        <RoadmapListBase
          items={community.roadmapItems}
          total={community.roadmapItems.length}
          compact
          limit={3}
          className="entry-roadmap-panel"
        />
      </section>
    </main>
  )
}

import { useEffect, useState, type ReactNode } from 'react'
import {
  getSignedInUserLabel,
  isAuthRequired,
  pingCurrentUserActivity,
  signInAsVisitor,
  signInWithPassword,
  signUpWithPassword,
} from '../../engineweb/auth/cognito.ts'

type UserAuthGateProps = {
  children: (props: { userLabel: string }) => ReactNode
}

export function UserAuthGate({ children }: UserAuthGateProps) {
  const [userLabel, setUserLabel] = useState('')
  const [mode, setMode] = useState<'sign_in' | 'sign_up'>('sign_in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (!isAuthRequired()) {
      setReady(true)
      return
    }

    void getSignedInUserLabel()
      .then((label) => setUserLabel(label))
      .catch(() => setUserLabel(''))
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
    return <>{children({ userLabel })}</>
  }

  return (
    <main className="simple-app">
      <section className="hero-card">
        <p className="eyebrow">FiapFlow</p>
        <h1>{mode === 'sign_up' ? 'Criar conta no portal do aluno' : 'Entrar no portal do aluno'}</h1>
        <p className="hero-text">
          {mode === 'sign_up'
            ? 'Crie sua conta com email e senha para acessar o portal.'
            : 'Use seu email e senha, ou entre como visitante.'}
        </p>
        <div className="admin-gate">
          <label className="admin-gate-label" htmlFor="user-email">Email</label>
          <input id="user-email" className="admin-gate-input" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="voce@exemplo.com" />
          <label className="admin-gate-label" htmlFor="user-password">Senha</label>
          <input id="user-password" className="admin-gate-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Sua senha" />
          {notice ? <p className="hero-text">{notice}</p> : null}
          {error ? <p className="hero-text">{error}</p> : null}
          <div className="action-row">
            {mode === 'sign_in' ? (
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  setError('')
                  setNotice('')
                  void signInWithPassword(email, password)
                    .then(() => getSignedInUserLabel())
                    .then((label) => setUserLabel(label))
                    .catch(() => setError('Nao foi possivel autenticar com as credenciais informadas.'))
                    .finally(() => setBusy(false))
                }}
              >
                {busy ? 'Entrando...' : 'Entrar'}
              </button>
            ) : null}
            {mode === 'sign_in' ? (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  setError('')
                  setNotice('')
                  void signInAsVisitor()
                    .then((label) => {
                      setNotice('Entrando como visitante.')
                      setUserLabel(label)
                    })
                    .catch(() => setError('Nao foi possivel abrir o portal como visitante agora.'))
                    .finally(() => setBusy(false))
                }}
              >
                {busy ? 'Abrindo...' : 'Entrar como visitante'}
              </button>
            ) : null}
            {mode === 'sign_up' ? (
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  setError('')
                  setNotice('')
                  void signUpWithPassword({ email, password })
                    .then(() => getSignedInUserLabel())
                    .then((label) => {
                      setNotice('Conta criada com sucesso.')
                      setUserLabel(label)
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
              >
                {busy ? 'Criando...' : 'Criar conta'}
              </button>
            ) : null}
            {mode !== 'sign_in' ? (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  setMode('sign_in')
                  setError('')
                  setNotice('')
                }}
              >
                Ja tenho conta
              </button>
            ) : null}
            {mode === 'sign_in' ? (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  setMode('sign_up')
                  setError('')
                  setNotice('')
                }}
              >
                Criar conta
              </button>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  )
}

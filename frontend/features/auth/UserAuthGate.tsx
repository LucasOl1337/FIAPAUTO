import { useEffect, useState, type ReactNode } from 'react'
import { getSignedInUserLabel, isCognitoConfigured, signInWithPassword } from '../../engineweb/auth/cognito.ts'

type UserAuthGateProps = {
  children: (props: { userLabel: string }) => ReactNode
}

export function UserAuthGate({ children }: UserAuthGateProps) {
  const [userLabel, setUserLabel] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isCognitoConfigured()) {
      setReady(true)
      return
    }

    void getSignedInUserLabel()
      .then((label) => setUserLabel(label))
      .catch(() => setUserLabel(''))
      .finally(() => setReady(true))
  }, [])

  if (!ready) {
    return (
      <main className="simple-app">
        <section className="hero-card">
          <p className="eyebrow">FIAPAUTO</p>
          <h1>Validando sessao do usuario</h1>
          <p className="hero-text">Estamos preparando o acesso autenticado ao portal do aluno.</p>
        </section>
      </main>
    )
  }

  if (!isCognitoConfigured() || userLabel) {
    return <>{children({ userLabel })}</>
  }

  return (
    <main className="simple-app">
      <section className="hero-card">
        <p className="eyebrow">FIAPAUTO</p>
        <h1>Entrar no portal do aluno</h1>
        <p className="hero-text">Use sua conta configurada no Cognito para acessar o site publicado.</p>
        <div className="admin-gate">
          <label className="admin-gate-label" htmlFor="user-email">Email</label>
          <input id="user-email" className="admin-gate-input" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="voce@exemplo.com" />
          <label className="admin-gate-label" htmlFor="user-password">Senha</label>
          <input id="user-password" className="admin-gate-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Sua senha" />
          {error ? <p className="hero-text">{error}</p> : null}
          <div className="action-row">
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                setError('')
                void signInWithPassword(email, password)
                  .then(() => getSignedInUserLabel())
                  .then((label) => setUserLabel(label))
                  .catch(() => setError('Nao foi possivel autenticar com as credenciais informadas.'))
                  .finally(() => setBusy(false))
              }}
            >
              {busy ? 'Entrando...' : 'Entrar'}
            </button>
          </div>
        </div>
      </section>
    </main>
  )
}

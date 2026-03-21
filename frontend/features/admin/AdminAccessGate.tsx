import { useEffect, useState, type ReactNode } from 'react'
import { fetchHealthStatus, getStoredAdminToken, storeAdminToken } from '../../engineweb/api/botApi.ts'

type AdminAccessGateProps = {
  children: ReactNode
}

export function AdminAccessGate({ children }: AdminAccessGateProps) {
  const [tokenInput, setTokenInput] = useState(() => getStoredAdminToken())
  const [tokenReady, setTokenReady] = useState(() => getStoredAdminToken().length > 0)
  const [adminProtectionEnabled, setAdminProtectionEnabled] = useState(false)
  const [healthChecked, setHealthChecked] = useState(false)

  useEffect(() => {
    void fetchHealthStatus()
      .then((payload) => {
        setAdminProtectionEnabled(payload.adminProtectionEnabled)
      })
      .catch(() => {
        setAdminProtectionEnabled(false)
      })
      .finally(() => {
        setHealthChecked(true)
      })
  }, [])

  if (!healthChecked) {
    return (
      <main className="simple-app">
        <section className="hero-card">
          <p className="eyebrow">FIAPAUTO Admin</p>
          <h1>Validando acesso ao painel</h1>
          <p className="hero-text">Estamos confirmando se o backend exige token administrativo.</p>
        </section>
      </main>
    )
  }

  if (!adminProtectionEnabled || tokenReady) {
    return <>{children}</>
  }

  return (
    <main className="simple-app">
      <section className="hero-card">
        <div className="hero-topbar">
          <div>
            <p className="eyebrow">FIAPAUTO Admin</p>
            <h1>Painel protegido por token</h1>
            <p className="hero-text">Este acesso fica fora do fluxo publico e precisa de um token administrativo valido.</p>
          </div>
        </div>
        <div className="admin-gate">
          <label className="admin-gate-label" htmlFor="admin-token">
            Token administrativo
          </label>
          <input
            id="admin-token"
            className="admin-gate-input"
            type="password"
            value={tokenInput}
            onChange={(event) => setTokenInput(event.target.value)}
            placeholder="Cole o token configurado no backend"
          />
          <div className="action-row">
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                storeAdminToken(tokenInput)
                setTokenReady(tokenInput.trim().length > 0)
              }}
            >
              Entrar no admin
            </button>
          </div>
        </div>
      </section>
    </main>
  )
}

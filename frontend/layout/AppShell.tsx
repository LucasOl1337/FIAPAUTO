import './AppShell.css'
import { signOutCurrentUser } from '../engineweb/auth/cognito.ts'
import { useWorkspaceController } from '../engineweb/useWorkspaceController.ts'
import { AdminAccessGate } from '../features/admin/AdminAccessGate.tsx'
import { UserAuthGate } from '../features/auth/UserAuthGate.tsx'
import { AdminOverview } from '../features/admin/AdminOverview.tsx'
import { AulasView } from '../features/aulas/AulasView.tsx'
import { LearningView } from '../features/aprendizado/LearningView.tsx'
import { WorksView } from '../features/trabalhos/WorksView.tsx'

export default function AppShell() {
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/'

  if (pathname === '/admin') {
    return (
      <AdminAccessGate>
        <AdminApp />
      </AdminAccessGate>
    )
  }

  return (
    <UserAuthGate>
      {({ userLabel }) => <PublicApp userLabel={userLabel} />}
    </UserAuthGate>
  )
}

function PublicApp(props: { userLabel: string }) {
  const controller = useWorkspaceController('user')

  return (
    <main className="simple-app">
      <section className="hero-card">
        <div className="hero-topbar">
          <div className="brand-block">
            <div className="brand-line">
              <BrandMark />
              <p className="eyebrow">FIAPAUTO</p>
            </div>
            <h1>Assistente de Materias</h1>
            <p className="hero-text">Experiencia publica focada em entender entregaveis, contexto da materia e proximos passos.</p>
          </div>
          {props.userLabel ? (
            <div className="action-row">
              <span className="admin-badge">{props.userLabel}</span>
              <button type="button" className="secondary-button" onClick={() => void signOutCurrentUser().then(() => window.location.reload())}>
                Sair
              </button>
            </div>
          ) : null}
        </div>
      </section>

      <NavigationTabs activeTab={controller.activeTab} onChange={controller.setActiveTab} />
      <ContentByTab controller={controller} />

      <section className="footer-card compact-footer">
        <p className="eyebrow">Atividade</p>
        <strong>{controller.activity}</strong>
      </section>
    </main>
  )
}

function AdminApp() {
  const controller = useWorkspaceController('admin')

  return (
    <main className="simple-app">
      <AdminOverview controller={controller} />
      <NavigationTabs activeTab={controller.activeTab} onChange={controller.setActiveTab} />
      <ContentByTab controller={controller} />

      <section className="footer-card compact-footer">
        <p className="eyebrow">Atividade</p>
        <strong>{controller.activity}</strong>
        <div className="log-panel">
          <span>Log da automacao</span>
          <div className="log-lines">
            {controller.botState.logs.length > 0
              ? controller.botState.logs.map((line) => (
                  <code key={line} className="log-line">
                    {line}
                  </code>
                ))
              : <span className="placeholder-text">Nenhum log registrado ainda.</span>}
          </div>
        </div>
      </section>
    </main>
  )
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 64 64" role="img">
        <defs>
          <linearGradient id="brand-red" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#ff6969" />
            <stop offset="35%" stopColor="#ff3d4f" />
            <stop offset="100%" stopColor="#c6002b" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="18" fill="#111" />
        <g fill="url(#brand-red)">
          <path d="M12 16c0-3.3 2.7-6 6-6h16c0 5.5-4.5 10-10 10H18v6h12l-6 8H18v16h-6z" />
          <path d="M36 16c0-3.3 2.7-6 6-6h16c0 5.5-4.5 10-10 10H42v6h12l-6 8H42v16h-6z" />
        </g>
      </svg>
    </span>
  )
}

function NavigationTabs(props: {
  activeTab: 'aulas' | 'trabalhos' | 'aprendizado'
  onChange: (tab: 'aulas' | 'trabalhos' | 'aprendizado') => void
}) {
  return (
    <section className="tab-row">
      <button type="button" className={props.activeTab === 'aulas' ? 'tab-button active' : 'tab-button'} onClick={() => props.onChange('aulas')}>Aulas</button>
      <button type="button" className={props.activeTab === 'trabalhos' ? 'tab-button active' : 'tab-button'} onClick={() => props.onChange('trabalhos')}>Trabalhos</button>
      <button type="button" className={props.activeTab === 'aprendizado' ? 'tab-button active' : 'tab-button'} onClick={() => props.onChange('aprendizado')}>Aprendizado</button>
    </section>
  )
}

function ContentByTab(props: { controller: ReturnType<typeof useWorkspaceController> }) {
  return props.controller.activeTab === 'aulas'
    ? <AulasView controller={props.controller} />
    : props.controller.activeTab === 'trabalhos'
      ? <WorksView controller={props.controller} />
      : <LearningView controller={props.controller} />
}

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
              <p className="eyebrow">FiapFlow</p>
            </div>
            <h1>Assistente de Estudos</h1>
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
      <img src="/brand-icon.jpg" alt="" />
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

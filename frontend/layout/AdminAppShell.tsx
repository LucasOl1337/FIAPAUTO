import './AppShell.css'
import { useAdminWorkspaceController } from '../engineweb/useAdminWorkspaceController.ts'
import { AdminAccessGate } from '../features/admin/AdminAccessGate.tsx'
import { AdminOverview } from '../features/admin/AdminOverview.tsx'
import { AulasView } from '../features/aulas/AulasView.tsx'
import { LearningView } from '../features/aprendizado/LearningView.tsx'
import { WorksView } from '../features/trabalhos/WorksView.tsx'
import { CommunityView } from '../features/community/CommunityHub.tsx'
import { NavigationTabs } from './ShellPrimitives.tsx'

export function AdminAppShell() {
  const controller = useAdminWorkspaceController()

  return (
    <AdminAccessGate>
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
    </AdminAccessGate>
  )
}

function ContentByTab(props: {
  controller: ReturnType<typeof useAdminWorkspaceController>
}) {
  return props.controller.activeTab === 'aulas'
    ? <AulasView controller={props.controller} />
    : props.controller.activeTab === 'trabalhos'
      ? <WorksView controller={props.controller} />
      : props.controller.activeTab === 'aprendizado'
        ? <LearningView controller={props.controller} />
        : <CommunityView viewer={{ userId: null, userLabel: '', isGuest: false, canParticipate: false }} />
}

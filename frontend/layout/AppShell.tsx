import './AppShell.css'
import { useWorkspaceController } from '../engineweb/useWorkspaceController.ts'
import { AdminOverview } from '../features/admin/AdminOverview.tsx'
import { AulasView } from '../features/aulas/AulasView.tsx'
import { LearningView } from '../features/aprendizado/LearningView.tsx'
import { WorksView } from '../features/trabalhos/WorksView.tsx'

export default function AppShell() {
  const controller = useWorkspaceController()

  return (
    <main className="simple-app">
      <AdminOverview controller={controller} />

      <section className="tab-row">
        <button type="button" className={controller.activeTab === 'aulas' ? 'tab-button active' : 'tab-button'} onClick={() => controller.setActiveTab('aulas')}>Aulas</button>
        <button type="button" className={controller.activeTab === 'trabalhos' ? 'tab-button active' : 'tab-button'} onClick={() => controller.setActiveTab('trabalhos')}>Trabalhos</button>
        <button type="button" className={controller.activeTab === 'aprendizado' ? 'tab-button active' : 'tab-button'} onClick={() => controller.setActiveTab('aprendizado')}>Aprendizado</button>
      </section>

      {controller.activeTab === 'aulas'
        ? <AulasView controller={controller} />
        : controller.activeTab === 'trabalhos'
          ? <WorksView controller={controller} />
          : <LearningView controller={controller} />}

      <section className="footer-card compact-footer">
        <p className="eyebrow">Atividade</p>
        <strong>{controller.activity}</strong>
        {controller.viewMode === 'admin' ? (
          <div className="log-panel">
            <span>Log da automacao</span>
            <div className="log-lines">{controller.botState.logs.length > 0 ? controller.botState.logs.map((line) => <code key={line} className="log-line">{line}</code>) : <span className="placeholder-text">Nenhum log registrado ainda.</span>}</div>
          </div>
        ) : null}
      </section>
    </main>
  )
}

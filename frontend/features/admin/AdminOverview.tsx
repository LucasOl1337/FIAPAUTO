import { StatusCard } from '../../layout/StatusCard.tsx'
import { formatTimestamp, type WorkspaceController } from '../../engineweb/useWorkspaceController.ts'

type AdminOverviewProps = {
  controller: WorkspaceController
}

export function AdminOverview({ controller }: AdminOverviewProps) {
  return (
    <section className="hero-card">
      <div className="hero-topbar">
        <div>
          <p className="eyebrow">FIAPAUTO</p>
          <h1>{controller.viewMode === 'user' ? 'Assistente de Materias' : 'Bot de gravacao, transcricao e topicos'}</h1>
          {controller.viewMode === 'admin' ? <p className="hero-text">Painel operacional com captura, resumo persistido e memoria do agente.</p> : null}
        </div>
        <div className="mode-switch" role="tablist" aria-label="Modo de visualizacao">
          <button type="button" className={controller.viewMode === 'user' ? 'mode-button active' : 'mode-button'} onClick={() => controller.setViewMode('user')}>Usuario</button>
          <button type="button" className={controller.viewMode === 'admin' ? 'mode-button active' : 'mode-button'} onClick={() => controller.setViewMode('admin')}>Admin</button>
        </div>
      </div>

      {controller.viewMode === 'admin' ? (
        <>
          <div className="action-row">
            <button type="button" className="secondary-button" disabled={controller.botBusy !== null} onClick={() => void controller.connectTeams()}>{controller.botBusy === 'connect' ? 'Abrindo Teams...' : 'Conectar Teams'}</button>
            <button type="button" className="primary-button" disabled={controller.botBusy !== null} onClick={() => void controller.runBotFromSite()}>{controller.botBusy === 'test' ? 'Executando bot...' : 'Executar bot agora'}</button>
            <button type="button" className="secondary-button" disabled={controller.botBusy !== null} onClick={() => void controller.refreshBotStatus()}>{controller.botBusy === 'load' ? 'Atualizando...' : 'Atualizar status'}</button>
            <button type="button" className="secondary-button" disabled={controller.botBusy !== null} onClick={() => void controller.resetAll()}>{controller.botBusy === 'reset' ? 'Resetando...' : 'Resetar demo'}</button>
          </div>
          <div className="status-grid">
            <StatusCard label="API do bot" value={controller.botState.apiConnected ? 'Conectada' : 'Offline'} />
            <StatusCard label="Sessao Teams" value={controller.botState.authStatus === 'authenticated' ? 'Autenticada' : 'Login pendente'} />
            <StatusCard label="Aulas importadas" value={String(controller.importedLessons.length)} />
            <StatusCard label="Topicos" value={String(controller.botState.topics.length)} />
            <StatusCard label="Ao vivo agora" value={String(controller.botState.liveMeetings.length)} />
            <StatusCard label="LLM" value={controller.botState.llm.hasApiKey ? 'Configurado' : 'Sem token'} />
            <StatusCard label="Ultima varredura" value={controller.botState.scannedAt ? formatTimestamp(controller.botState.scannedAt) : 'Ainda nao rodou'} />
          </div>
        </>
      ) : null}
    </section>
  )
}

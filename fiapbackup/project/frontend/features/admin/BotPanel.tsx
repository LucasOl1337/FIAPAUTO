import type { BotJob, ReadyLesson } from '../../engineweb/api/botApi.ts'

type BotPanelProps = {
  jobs: BotJob[]
  readyLessons: ReadyLesson[]
  apiConnected: boolean
  busy: 'load' | 'test' | 'reset' | null
  onRun: () => void
  onRefresh: () => void
  onReset: () => void
  onSelectReadyLesson: (lessonId: string, lessonTitle: string) => void
  onSelectJob: (title: string) => void
}

export function BotPanel({
  jobs,
  readyLessons,
  apiConnected,
  busy,
  onRun,
  onRefresh,
  onReset,
  onSelectReadyLesson,
  onSelectJob,
}: BotPanelProps) {
  return (
    <>
      <div className="module-header">
        <div>
          <p className="section-kicker">Bot</p>
          <h2>Microsoft Teams + Playwright</h2>
        </div>
        <div className="module-actions">
          <button type="button" className="primary-button" disabled={busy !== null} onClick={onRun}>
            {busy === 'test' ? 'Executando...' : 'Executar bot demo'}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy !== null}
            onClick={onRefresh}
          >
            {busy === 'load' ? 'Atualizando...' : 'Atualizar status'}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy !== null}
            onClick={onReset}
          >
            {busy === 'reset' ? 'Resetando...' : 'Resetar bot'}
          </button>
        </div>
      </div>

      <div className="panel-grid">
        <div className="surface-card list-card">
          <div className="list-card-header">
            <h3>API do bot</h3>
            <span>{apiConnected ? 'Conectada' : 'Offline'}</span>
          </div>
          <div className="stack-list">
            <div className="info-row">
              <strong>Teste pelo site</strong>
              <p>Executa o bot local e injeta a aula gravada no dashboard.</p>
            </div>
            <div className="info-row">
              <strong>Plataforma</strong>
              <p>Microsoft Teams com automacao via Playwright.</p>
            </div>
            <div className="info-row">
              <strong>Status atual</strong>
              <p>
                {apiConnected
                  ? 'Tudo pronto para testar pelo botao.'
                  : 'Suba o ambiente com npm run dev para ativar a API local.'}
              </p>
            </div>
          </div>
        </div>

        <div className="surface-card list-card">
          <div className="list-card-header">
            <h3>Jobs do bot</h3>
            <span>{jobs.length} jobs</span>
          </div>
          <div className="stack-list">
            {jobs.length > 0 ? (
              jobs.map((job) => (
                <button
                  key={job.id}
                  type="button"
                  className="lesson-row"
                  onClick={() => onSelectJob(job.lessonTitle)}
                >
                  <div>
                    <strong>{job.lessonTitle}</strong>
                    <p>
                      {job.platform} - {new Date(job.scheduledStart).toLocaleString('pt-BR')}
                    </p>
                  </div>
                  <span className="badge neutral">{job.status}</span>
                </button>
              ))
            ) : (
              <p className="empty-state">Nenhum job carregado.</p>
            )}
          </div>
        </div>

        <div className="surface-card list-card full-span">
          <div className="list-card-header">
            <h3>Aulas prontas para transcricao</h3>
            <span>{readyLessons.length} itens</span>
          </div>
          <div className="stack-list">
            {readyLessons.length > 0 ? (
              readyLessons.map((item) => (
                <button
                  key={item.jobId}
                  type="button"
                  className="lesson-row"
                  onClick={() => onSelectReadyLesson(item.lessonId, item.lessonTitle)}
                >
                  <div>
                    <strong>{item.lessonTitle}</strong>
                    <p>{item.recordingUrl}</p>
                  </div>
                  <span className="badge success">Pronta</span>
                </button>
              ))
            ) : (
              <p className="empty-state">Nenhum arquivo pronto para transcricao ainda.</p>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

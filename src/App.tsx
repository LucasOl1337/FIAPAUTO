import { useEffect, useEffectEvent, useMemo, useState } from 'react'
import './App.css'
import {
  askTopicAssistant,
  buildBotFileUrl,
  connectTeamsSession,
  emptyBotState,
  fetchBotStatus,
  fetchTopic,
  fetchTopicDebug,
  generateTopicMemory,
  generateTopicSummary,
  normalizeLessonTitle,
  resetBotDemo,
  runBotDemo,
  syncReadyLessonsIntoWorkspace,
  type BotState,
  type SubjectTopic,
  type TopicAskResult,
  type TopicSummaryResult,
} from './lib/botApi'
import { initialWorkspaceState } from './lib/demoData'
import { loadWorkspaceState, resetWorkspaceState, saveWorkspaceState } from './lib/storage'
import type { WorkspaceState } from './types'

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => loadWorkspaceState())
  const [botState, setBotState] = useState<BotState>(emptyBotState)
  const [selectedLessonId, setSelectedLessonId] = useState(
    () => loadWorkspaceState().lessons[0]?.id ?? initialWorkspaceState.lessons[0]?.id ?? '',
  )
  const [selectedTopicId, setSelectedTopicId] = useState('')
  const [selectedTopic, setSelectedTopic] = useState<SubjectTopic | null>(null)
  const [topicSummary, setTopicSummary] = useState<TopicSummaryResult | null>(null)
  const [topicAnswer, setTopicAnswer] = useState<TopicAskResult | null>(null)
  const [topicQuestion, setTopicQuestion] = useState('')
  const [topicDebugEvents, setTopicDebugEvents] = useState<BotState['llmDebug']['events']>([])
  const [activity, setActivity] = useState('Projeto pronto para testar o bot')
  const [botBusy, setBotBusy] = useState<'connect' | 'load' | 'test' | 'reset' | null>(null)
  const [topicBusy, setTopicBusy] = useState<'summary' | 'memory' | 'ask' | 'detail' | null>(null)
  const [activeTab, setActiveTab] = useState<'aulas' | 'trabalhos'>('aulas')
  const [viewMode, setViewMode] = useState<'admin' | 'user'>('user')
  const refreshBotStatusEvent = useEffectEvent((showMessage = false) => {
    void refreshBotStatus(showMessage)
  })

  useEffect(() => {
    saveWorkspaceState(workspace)
  }, [workspace])

  useEffect(() => {
    refreshBotStatusEvent(false)
  }, [])

  useEffect(() => {
    if (botState.authStatus === 'authenticated') return
    const timer = window.setInterval(() => refreshBotStatusEvent(false), 5000)
    return () => window.clearInterval(timer)
  }, [botState.authStatus])

  useEffect(() => {
    if (!workspace.lessons.find((lesson) => lesson.id === selectedLessonId)) {
      setSelectedLessonId(workspace.lessons[0]?.id ?? '')
    }
  }, [selectedLessonId, workspace.lessons])

  useEffect(() => {
    if (!botState.topics.find((topic) => topic.id === selectedTopicId)) {
      setSelectedTopicId(botState.topics[0]?.id ?? '')
    }
  }, [botState.topics, selectedTopicId])

  useEffect(() => {
    if (!selectedTopicId) {
      setSelectedTopic(null)
      setTopicDebugEvents([])
      return
    }
    void loadTopicDetail(selectedTopicId)
  }, [selectedTopicId])

  const importedLessons = useMemo(
    () => workspace.lessons.filter((lesson) => lesson.notes.includes('Importado automaticamente pelo bot do Teams')),
    [workspace.lessons],
  )
  const selectedLesson = useMemo(
    () => importedLessons.find((lesson) => lesson.id === selectedLessonId) ?? importedLessons[0] ?? null,
    [importedLessons, selectedLessonId],
  )
  const selectedTranscript = useMemo(
    () => workspace.transcripts.find((transcript) => transcript.lessonId === selectedLesson?.id) ?? null,
    [selectedLesson?.id, workspace.transcripts],
  )
  const selectedTopicListItem = useMemo(
    () => botState.topics.find((topic) => topic.id === selectedTopicId) ?? botState.topics[0] ?? null,
    [botState.topics, selectedTopicId],
  )

  async function refreshBotStatus(showMessage = true) {
    setBotBusy('load')
    try {
      const data = await fetchBotStatus()
      setBotState(mapBotState(data))
      setWorkspace((current) => syncReadyLessonsIntoWorkspace(current, data.readyLessons))
      setTopicSummary(null)
      setTopicAnswer(null)
      if (data.readyLessons[0]) setSelectedLessonId(data.readyLessons[0].lessonId)
      if (!selectedTopicId && data.topics[0]) setSelectedTopicId(data.topics[0].id)
      if (showMessage) setActivity('Status do bot atualizado')
    } catch {
      setBotState((current) => ({ ...current, apiConnected: false }))
      if (showMessage) setActivity('API do bot nao respondeu. Rode npm run dev para subir tudo junto.')
    } finally {
      setBotBusy(null)
    }
  }

  async function runBotFromSite() {
    setBotBusy('test')
    try {
      const data = await runBotDemo()
      setBotState(mapBotState(data))
      setWorkspace((current) => syncReadyLessonsIntoWorkspace(current, data.readyLessons))
      setTopicSummary(null)
      setTopicAnswer(null)
      if (data.readyLessons[0]) setSelectedLessonId(data.readyLessons[0].lessonId)
      if (data.topics[0]) setSelectedTopicId(data.topics[0].id)
      if (data.runtimeError) return setActivity(explainRuntimeError(data.runtimeError))
      if (data.workspaceReport.authStatus !== 'authenticated') {
        return setActivity('Teams precisa de login. Use "Conectar Teams" para salvar a sessao e tente novamente.')
      }
      if (data.executedJobs > 0) return setActivity(`Bot executado: ${data.executedJobs} aula(s) ao vivo processada(s).`)
      setActivity('Varredura concluida. Materias e trabalhos foram atualizados no workspace de topicos.')
    } catch (error) {
      if (error instanceof Error && error.message === 'scan_in_progress') {
        const payload = (error as Error & { payload?: Parameters<typeof mapBotState>[0] }).payload
        if (payload) setBotState(mapBotState(payload))
        return setActivity('O bot ja esta executando uma varredura. Aguarde alguns segundos e atualize o status.')
      }
      setActivity('Falha ao executar o bot pelo site.')
    } finally {
      setBotBusy(null)
    }
  }

  async function connectTeams() {
    setBotBusy('connect')
    try {
      const data = await connectTeamsSession()
      setBotState(mapBotState(data))
      setTopicSummary(null)
      setTopicAnswer(null)
      if (data.runtimeError) return setActivity(explainRuntimeError(data.runtimeError))
      setActivity(data.connected ? 'Sessao do Teams confirmada.' : 'A janela do Teams foi aberta para concluir o login.')
    } catch {
      setActivity('Falha ao abrir a sessao do Teams.')
    } finally {
      setBotBusy(null)
    }
  }

  async function resetAll() {
    setBotBusy('reset')
    try {
      const data = await resetBotDemo()
      setBotState(mapBotState(data))
      setTopicSummary(null)
      setTopicAnswer(null)
      setSelectedTopic(null)
      setTopicDebugEvents([])
      const state = resetWorkspaceState()
      setWorkspace(state)
      setSelectedLessonId(state.lessons[0]?.id ?? '')
      setSelectedTopicId('')
      setActivity('Demo resetada. O bot esta pronto para um novo teste.')
    } catch {
      setActivity('Falha ao resetar a demo.')
    } finally {
      setBotBusy(null)
    }
  }

  async function loadTopicDetail(topicId: string) {
    setTopicBusy('detail')
    try {
      const [topic, debug] = await Promise.all([fetchTopic(topicId), fetchTopicDebug(topicId)])
      setSelectedTopic(topic)
      setTopicDebugEvents(debug.events)
      setTopicSummary(
        topic.summary
          ? {
              topicId: topic.id,
              moduleKey: topic.moduleKey,
              summary: topic.summary,
              warnings: topic.warnings,
              filesUsed: topic.attachments.map((item) => item.path),
              generatedAt: topic.summaryGeneratedAt || topic.updatedAt,
            }
          : null,
      )
    } catch {
      setActivity('Falha ao carregar os detalhes do topico selecionado.')
    } finally {
      setTopicBusy(null)
    }
  }

  async function handleGenerateSummary(force = false) {
    if (!selectedTopicListItem) return
    setTopicBusy('summary')
    try {
      const result = await generateTopicSummary(selectedTopicListItem.id, force)
      setTopicSummary(result)
      await loadTopicDetail(selectedTopicListItem.id)
      await refreshBotStatus(false)
      setActivity(`Resumo persistido para a materia ${selectedTopicListItem.title}.`)
    } catch {
      setActivity('Falha ao gerar o resumo persistido do topico.')
    } finally {
      setTopicBusy(null)
    }
  }

  async function handleGenerateMemory(force = false) {
    if (!selectedTopicListItem) return
    setTopicBusy('memory')
    try {
      await generateTopicMemory(selectedTopicListItem.id, force)
      await loadTopicDetail(selectedTopicListItem.id)
      await refreshBotStatus(false)
      setActivity(`Memoria do agente atualizada para a materia ${selectedTopicListItem.title}.`)
    } catch {
      setActivity('Falha ao gerar a memoria persistida do agente.')
    } finally {
      setTopicBusy(null)
    }
  }

  async function handleAskTopic() {
    const question = topicQuestion.trim()
    if (!question || !selectedTopicListItem) {
      setActivity('Digite uma pergunta e selecione uma materia antes de consultar o agente.')
      return
    }
    setTopicBusy('ask')
    try {
      const result = await askTopicAssistant({ topicId: selectedTopicListItem.id, question })
      setTopicAnswer(result)
      await loadTopicDetail(selectedTopicListItem.id)
      await refreshBotStatus(false)
      setActivity(result.usedFallback ? 'Resposta gerada com fallback do LLM.' : 'Resposta entregue pela memoria persistida.')
    } catch {
      setActivity('Falha ao perguntar ao agente da materia.')
    } finally {
      setTopicBusy(null)
    }
  }

  return (
    <main className="simple-app">
      <section className="hero-card">
        <div className="hero-topbar">
          <div>
            <p className="eyebrow">FIAPAUTO</p>
            <h1>{viewMode === 'user' ? 'Assistente de Materias' : 'Bot de gravacao, transcricao e topicos'}</h1>
            {viewMode === 'admin' ? <p className="hero-text">Painel operacional com captura, resumo persistido e memoria do agente.</p> : null}
          </div>
          <div className="mode-switch" role="tablist" aria-label="Modo de visualizacao">
            <button type="button" className={viewMode === 'user' ? 'mode-button active' : 'mode-button'} onClick={() => setViewMode('user')}>Usuario</button>
            <button type="button" className={viewMode === 'admin' ? 'mode-button active' : 'mode-button'} onClick={() => setViewMode('admin')}>Admin</button>
          </div>
        </div>

        {viewMode === 'admin' ? (
          <>
            <div className="action-row">
              <button type="button" className="secondary-button" disabled={botBusy !== null} onClick={() => void connectTeams()}>{botBusy === 'connect' ? 'Abrindo Teams...' : 'Conectar Teams'}</button>
              <button type="button" className="primary-button" disabled={botBusy !== null} onClick={() => void runBotFromSite()}>{botBusy === 'test' ? 'Executando bot...' : 'Executar bot agora'}</button>
              <button type="button" className="secondary-button" disabled={botBusy !== null} onClick={() => void refreshBotStatus()}>{botBusy === 'load' ? 'Atualizando...' : 'Atualizar status'}</button>
              <button type="button" className="secondary-button" disabled={botBusy !== null} onClick={() => void resetAll()}>{botBusy === 'reset' ? 'Resetando...' : 'Resetar demo'}</button>
            </div>
            <div className="status-grid">
              <StatusCard label="API do bot" value={botState.apiConnected ? 'Conectada' : 'Offline'} />
              <StatusCard label="Sessao Teams" value={botState.authStatus === 'authenticated' ? 'Autenticada' : 'Login pendente'} />
              <StatusCard label="Aulas importadas" value={String(importedLessons.length)} />
              <StatusCard label="Topicos" value={String(botState.topics.length)} />
              <StatusCard label="Ao vivo agora" value={String(botState.liveMeetings.length)} />
              <StatusCard label="LLM" value={botState.llm.hasApiKey ? 'Configurado' : 'Sem token'} />
              <StatusCard label="Ultima varredura" value={botState.scannedAt ? formatTimestamp(botState.scannedAt) : 'Ainda nao rodou'} />
            </div>
          </>
        ) : null}
      </section>

      <section className="tab-row">
        <button type="button" className={activeTab === 'aulas' ? 'tab-button active' : 'tab-button'} onClick={() => setActiveTab('aulas')}>Aulas</button>
        <button type="button" className={activeTab === 'trabalhos' ? 'tab-button active' : 'tab-button'} onClick={() => setActiveTab('trabalhos')}>Trabalhos</button>
      </section>

      {activeTab === 'aulas' ? (
        <section className="content-grid">
          <article className="panel-card">
            <div className="panel-header"><div><p className="eyebrow">Aulas do bot</p><h2>Gravacoes importadas</h2></div></div>
            <div className="list-column">
              {importedLessons.length > 0 ? importedLessons.map((lesson) => (
                <button key={lesson.id} type="button" className={selectedLesson?.id === lesson.id ? 'lesson-item active' : 'lesson-item'} onClick={() => { setSelectedLessonId(lesson.id); setActivity(`Aula selecionada: ${lesson.title}`) }}>
                  <strong>{lesson.title}</strong><span>{lesson.discipline}</span>
                </button>
              )) : <div className="empty-box">Nenhuma aula importada ainda.</div>}
            </div>
          </article>
          <article className="panel-card transcript-panel">
            <div className="panel-header"><div><p className="eyebrow">Transcricao</p><h2>{selectedLesson ? normalizeLessonTitle(selectedLesson.title) : 'Sem aula selecionada'}</h2></div></div>
            <div className="meta-card"><span>Nome da aula gravada</span><strong>{selectedLesson ? normalizeLessonTitle(selectedLesson.title) : 'Aguardando bot'}</strong></div>
            <div className="meta-card transcript-box"><span>Transcricao da aula</span><p>{selectedTranscript?.text ?? 'A transcricao aparecera aqui assim que o bot concluir a gravacao.'}</p></div>
          </article>
        </section>
      ) : (
        <section className="panel-card works-shell">
          <div className="panel-header">
            <div><p className="eyebrow">Trabalhos</p><h2>{viewMode === 'user' ? 'Suas materias' : 'Workspace por materia'}</h2></div>
            {viewMode === 'admin' ? <div className="workspace-summary"><span>Servico LLM</span><strong>{botState.llm.baseUrl ? `${botState.llm.baseUrl}${botState.llm.model ? ` (${botState.llm.model})` : ''}` : 'Nao configurado'}</strong></div> : null}
          </div>

          <section className="topics-rail">
            <div className="topics-header"><strong>Materias extraidas</strong><span>{botState.topics.length} topico(s)</span></div>
            <div className="topics-strip">
              {botState.topics.length > 0 ? botState.topics.map((topic) => (
                <button key={topic.id} type="button" className={selectedTopicId === topic.id ? 'topic-pill active' : 'topic-pill'} onClick={() => { setSelectedTopicId(topic.id); setTopicAnswer(null); setActivity(`Materia selecionada: ${topic.title}`) }}>
                  <strong>{topic.title}</strong><span>{topic.course || 'Curso nao identificado'}</span><small>{topic.dueText || 'Prazo nao encontrado'}</small>
                </button>
              )) : <div className="empty-box">Nenhuma materia extraida ainda.</div>}
            </div>
          </section>

          <div className="works-layout single-column">
            <article className="topic-detail clean">
              {selectedTopic ? (viewMode === 'user' ? (
                <>
                  <div className="topic-hero user-hero">
                    <div>
                      <p className="eyebrow">Materia selecionada</p>
                      <h3>{selectedTopic.title}</h3>
                      <p className="topic-subtitle">{selectedTopic.course || 'Curso nao identificado'} · {selectedTopic.dueText || 'Prazo nao encontrado'}</p>
                    </div>
                  </div>
                  <div className="user-focus-grid">
                    <div className="meta-card clean-card user-summary-card"><span>Resumo</span><p className="rich-paragraph">{topicSummary?.summary || selectedTopic.summary || 'Resumo ainda nao disponivel para esta materia.'}</p></div>
                    <div className="meta-card clean-card user-todo-card"><span>Entregaveis</span><div className="user-list">{compactTopicItems(selectedTopic.agentMemory?.deliverables).length > 0 ? compactTopicItems(selectedTopic.agentMemory?.deliverables).map((item) => <p key={item}>{item}</p>) : <p>Abra o anexo principal e confirme os entregaveis desta materia.</p>}</div></div>
                    <div className="meta-card clean-card user-deadline-card"><span>Prazo</span><div className="user-list"><p>{selectedTopic.dueText || 'Prazo nao encontrado.'}</p>{compactTopicItems(selectedTopic.agentMemory?.deadlines, 2).map((item) => <p key={item}>{item}</p>)}</div></div>
                    <div className="meta-card clean-card user-files-card"><span>Arquivos</span><div className="download-list">{selectedTopic.attachments.length > 0 ? selectedTopic.attachments.slice(0, 3).map((attachment) => <a key={attachment.path} className="download-chip" href={buildBotFileUrl(attachment.path)} target="_blank" rel="noreferrer">{attachment.name}</a>) : <span className="placeholder-text">Nenhum anexo registrado.</span>}</div></div>
                  </div>
                  <div className="meta-card clean-card user-ask-card">
                    <span>Pergunte sobre esta materia</span>
                    <textarea value={topicQuestion} onChange={(event) => setTopicQuestion(event.target.value)} placeholder="Ex.: o que preciso entregar? qual parte merece mais atencao?" rows={3} />
                    <div className="action-row"><button type="button" className="primary-button" disabled={topicBusy !== null} onClick={() => void handleAskTopic()}>{topicBusy === 'ask' ? 'Perguntando...' : 'Perguntar ao agente'}</button></div>
                    <p className="rich-paragraph">{topicAnswer?.answer || 'A resposta contextual do agente aparecera aqui.'}</p>
                  </div>
                </>
              ) : (
                <>
                  <div className="topic-hero">
                    <div>
                      <p className="eyebrow">Materia selecionada</p>
                      <h3>{selectedTopic.title}</h3>
                      <p className="topic-subtitle">{selectedTopic.course || 'Curso nao identificado'} · {selectedTopic.dueText || 'Prazo nao encontrado'} · {selectedTopic.status}</p>
                      <div className="topic-badges inline">
                        <span className="topic-badge">{selectedTopic.moduleKey}</span>
                        <span className="topic-badge">{selectedTopic.summaryGeneratedAt ? 'Resumo salvo' : 'Sem resumo'}</span>
                        <span className="topic-badge">{selectedTopic.agentMemoryGeneratedAt ? 'Agente pronto' : 'Memoria pendente'}</span>
                      </div>
                    </div>
                    <div className="action-row">
                      <button type="button" className="secondary-button" disabled={topicBusy !== null} onClick={() => void handleGenerateSummary(true)}>{topicBusy === 'summary' ? 'Gerando resumo...' : selectedTopic.summary ? 'Regenerar resumo' : 'Gerar resumo'}</button>
                      <button type="button" className="primary-button" disabled={topicBusy !== null} onClick={() => void handleGenerateMemory(true)}>{topicBusy === 'memory' ? 'Gerando memoria...' : selectedTopic.agentMemory ? 'Regenerar agente' : 'Gerar agente'}</button>
                    </div>
                  </div>
                  <div className="topic-main-grid">
                    <section className="topic-visual-panel">
                      <div className="section-heading"><strong>Screenshot da lista real</strong><span>{selectedTopic.screenshots.length > 0 ? `${selectedTopic.screenshots.length} captura(s)` : 'Sem captura ainda'}</span></div>
                      <div className="screenshot-frame">{selectedTopic.screenshots[0] ? <img src={buildBotFileUrl(selectedTopic.screenshots[0])} alt={`Screenshot do topico ${selectedTopic.title}`} className="topic-screenshot" /> : <div className="empty-box">Ainda nao existe screenshot vinculada a este topico.</div>}</div>
                    </section>
                    <section className="topic-info-stack">
                      <div className="meta-card clean-card"><span>Resumo persistido</span><p className="rich-paragraph">{topicSummary?.summary || selectedTopic.summary || 'Este topico ainda nao tem resumo salvo.'}</p></div>
                      <div className="meta-card clean-card"><span>Anexos e conteudo isolado</span><div className="download-list">{selectedTopic.attachments.length > 0 ? selectedTopic.attachments.map((attachment) => <a key={attachment.path} className="download-chip" href={buildBotFileUrl(attachment.path)} target="_blank" rel="noreferrer">{attachment.name}</a>) : <span className="placeholder-text">Nenhum anexo registrado neste topico.</span>}</div><pre className="content-preview">{selectedTopic.contentText || 'Conteudo textual ainda nao consolidado.'}</pre></div>
                    </section>
                  </div>
                  <div className="topic-agent-grid">
                    <div className="meta-card transcript-box clean-card">
                      <span>Agente da materia</span>
                      <p className="rich-paragraph">{selectedTopic.agentMemory?.overview || 'A memoria persistida ainda nao foi gerada para este topico.'}</p>
                      <div className="chip-row">{(selectedTopic.agentMemory?.deliverables || []).map((item) => <span key={item} className="info-chip">{item}</span>)}</div>
                      <textarea value={topicQuestion} onChange={(event) => setTopicQuestion(event.target.value)} placeholder="Ex.: o que preciso entregar? qual parte merece mais atencao?" rows={4} />
                      <div className="action-row">
                        <button type="button" className="primary-button" disabled={topicBusy !== null} onClick={() => void handleAskTopic()}>{topicBusy === 'ask' ? 'Perguntando...' : 'Perguntar ao agente'}</button>
                        <button type="button" className="secondary-button" disabled={topicBusy !== null} onClick={() => void handleGenerateMemory(false)}>Atualizar memoria salva</button>
                      </div>
                      <p className="rich-paragraph">{topicAnswer?.answer || 'A resposta contextual do agente aparecera aqui.'}</p>
                    </div>
                    <div className="meta-card transcript-box clean-card">
                      <span>Debug do topico</span>
                      <div className="log-lines tall">{topicDebugEvents.length > 0 ? topicDebugEvents.map((event) => <code key={event.id} className="log-line">[{formatTimestamp(event.ts)}] {event.endpoint} topic={event.topicId || 'sem-topico'} status={event.statusCode} duracao={event.durationMs}ms{event.error ? ` erro=${event.error}` : ''}{'\n'}request={safeJson(event.request)}{'\n'}response={safeJson(event.response)}</code>) : <span className="placeholder-text">Nenhum evento do LLM foi registrado para este topico ainda.</span>}</div>
                    </div>
                  </div>
                </>
              )) : <div className="empty-box">{topicBusy === 'detail' ? 'Carregando detalhes do topico...' : 'Selecione uma materia na faixa superior para abrir o conteudo.'}</div>}
            </article>
          </div>
        </section>
      )}

      <section className="footer-card compact-footer">
        <p className="eyebrow">Atividade</p>
        <strong>{activity}</strong>
        {viewMode === 'admin' ? (
          <div className="log-panel">
            <span>Log da automacao</span>
            <div className="log-lines">{botState.logs.length > 0 ? botState.logs.map((line) => <code key={line} className="log-line">{line}</code>) : <span className="placeholder-text">Nenhum log registrado ainda.</span>}</div>
          </div>
        ) : null}
      </section>
    </main>
  )
}

function StatusCard({ label, value }: { label: string; value: string }) {
  return <div className="status-card"><span>{label}</span><strong>{value}</strong></div>
}

function compactTopicItems(items: string[] | undefined, limit = 3) {
  return (items ?? []).map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean).map((item) => truncateText(item, 140)).slice(0, limit)
}

function truncateText(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trim()}...`
}

function mapBotState(data: {
  jobs: BotState['jobs']
  readyLessons: BotState['readyLessons']
  workspaceReport: { authStatus: BotState['authStatus']; liveMeetings: BotState['liveMeetings']; assignments: BotState['assignments']; scannedAt: string }
  topics: BotState['topics']
  logs: string[]
  llm?: BotState['llm']
  llmDebug?: BotState['llmDebug']
  runtimeError?: string
}) {
  return {
    jobs: data.jobs,
    readyLessons: data.readyLessons,
    liveMeetings: data.workspaceReport.liveMeetings,
    assignments: data.workspaceReport.assignments,
    topics: data.topics,
    logs: data.logs,
    authStatus: data.workspaceReport.authStatus,
    scannedAt: data.workspaceReport.scannedAt,
    apiConnected: true,
    llm: data.llm ?? emptyBotState.llm,
    llmDebug: data.llmDebug ?? emptyBotState.llmDebug,
    runtimeError: data.runtimeError ?? '',
  } satisfies BotState
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

function explainRuntimeError(error: string) {
  if (error === 'teams_login_required') return 'O Teams ainda nao esta autenticado. Clique em "Conectar Teams", conclua o login e tente novamente.'
  if (error === 'teams_browser_closed') return 'A janela do Teams foi fechada durante a automacao. Reabra com "Conectar Teams" e tente novamente.'
  if (error === 'assignments_view_not_loaded') return 'O bot abriu o Teams, mas nao conseguiu confirmar a tela de Atribuicoes.'
  return `Falha na automacao: ${error}`
}

function safeJson(value: unknown) {
  try { return JSON.stringify(value) } catch { return String(value) }
}

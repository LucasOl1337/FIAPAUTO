import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { requestSummaryFromProvider, requestTranscriptFromProvider } from './lib/demoPipeline'
import { initialWorkspaceState } from './lib/demoData'
import { loadWorkspaceState, resetWorkspaceState, saveWorkspaceState } from './lib/storage'
import type {
  CourseMaterial,
  Fragility,
  Lesson,
  LessonStatus,
  MaterialType,
  ModuleKey,
  Summary,
  Transcript,
  WorkspaceState,
} from './types'

type LessonFormState = {
  title: string
  discipline: string
  date: string
  recordingReference: string
  notes: string
}

type MaterialFormState = {
  title: string
  type: MaterialType
  reference: string
}

const modules: Array<{ key: ModuleKey; label: string; hint: string }> = [
  { key: 'aulas', label: 'Aulas', hint: 'Cadastro, historico e status' },
  { key: 'transcricao', label: 'Transcricao', hint: 'Fila e texto processado' },
  { key: 'resumos', label: 'Resumos', hint: 'Topicos-chave e acoes' },
  { key: 'fragilidades', label: 'Fragilidades', hint: 'Prioridades de estudo' },
  { key: 'organizacao', label: 'Organizacao', hint: 'Materiais, links e tarefas' },
]

const emptyLessonForm: LessonFormState = {
  title: '',
  discipline: '',
  date: '',
  recordingReference: '',
  notes: '',
}

const emptyMaterialForm: MaterialFormState = {
  title: '',
  type: 'link',
  reference: '',
}

function formatStatus(status: LessonStatus) {
  const labels: Record<LessonStatus, string> = {
    draft: 'Rascunho',
    recorded: 'Gravada',
    transcribing: 'Transcrevendo',
    transcribed: 'Transcrita',
    summarizing: 'Resumindo',
    summarized: 'Resumida',
  }

  return labels[status]
}

function getStatusClass(status: LessonStatus) {
  if (status === 'summarized') return 'success'
  if (status === 'transcribed' || status === 'recorded') return 'warning'
  if (status === 'transcribing' || status === 'summarizing') return 'processing'

  return 'neutral'
}

function App() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => loadWorkspaceState())
  const [activeModule, setActiveModule] = useState<ModuleKey>('aulas')
  const [selectedLessonId, setSelectedLessonId] = useState<string>(
    () => loadWorkspaceState().lessons[0]?.id ?? initialWorkspaceState.lessons[0]?.id ?? '',
  )
  const [lessonForm, setLessonForm] = useState<LessonFormState>(emptyLessonForm)
  const [materialForm, setMaterialForm] = useState<MaterialFormState>(emptyMaterialForm)
  const [activity, setActivity] = useState('Workspace carregado')
  const [busyAction, setBusyAction] = useState<'transcribe' | 'summarize' | 'pipeline' | null>(null)

  useEffect(() => {
    saveWorkspaceState(workspace)
  }, [workspace])

  useEffect(() => {
    if (!workspace.lessons.find((lesson) => lesson.id === selectedLessonId)) {
      setSelectedLessonId(workspace.lessons[0]?.id ?? '')
    }
  }, [selectedLessonId, workspace.lessons])

  const selectedLesson = useMemo(
    () => workspace.lessons.find((lesson) => lesson.id === selectedLessonId) ?? null,
    [selectedLessonId, workspace.lessons],
  )

  const selectedTranscript = useMemo(
    () => workspace.transcripts.find((transcript) => transcript.lessonId === selectedLessonId) ?? null,
    [selectedLessonId, workspace.transcripts],
  )

  const selectedSummary = useMemo(
    () => workspace.summaries.find((summary) => summary.lessonId === selectedLessonId) ?? null,
    [selectedLessonId, workspace.summaries],
  )

  const selectedFragilities = useMemo(
    () => workspace.fragilities.filter((fragility) => fragility.lessonId === selectedLessonId),
    [selectedLessonId, workspace.fragilities],
  )

  const selectedMaterials = useMemo(
    () => workspace.materials.filter((material) => material.lessonId === selectedLessonId),
    [selectedLessonId, workspace.materials],
  )

  const stats = useMemo(
    () => ({
      lessons: workspace.lessons.length,
      transcripts: workspace.transcripts.length,
      summaries: workspace.summaries.length,
      fragilities: workspace.fragilities.length,
      materials: workspace.materials.length,
    }),
    [workspace],
  )

  const moduleMeta = useMemo(
    () => ({
      aulas: `${stats.lessons} aulas`,
      transcricao: `${stats.transcripts} textos`,
      resumos: `${stats.summaries} resumos`,
      fragilidades: `${stats.fragilities} alertas`,
      organizacao: `${stats.materials} itens`,
    }),
    [stats],
  )

  function patchLesson(lessonId: string, patch: Partial<Lesson>) {
    setWorkspace((current) => ({
      ...current,
      lessons: current.lessons.map((lesson) =>
        lesson.id === lessonId
          ? {
              ...lesson,
              ...patch,
              updatedAt: new Date().toISOString(),
            }
          : lesson,
      ),
    }))
  }

  function upsertTranscript(transcript: Transcript) {
    setWorkspace((current) => ({
      ...current,
      transcripts: [
        ...current.transcripts.filter((item) => item.lessonId !== transcript.lessonId),
        transcript,
      ],
    }))
  }

  function upsertSummary(summary: Summary, fragilities: Fragility[]) {
    setWorkspace((current) => ({
      ...current,
      summaries: [...current.summaries.filter((item) => item.lessonId !== summary.lessonId), summary],
      fragilities: [
        ...current.fragilities.filter((item) => item.lessonId !== summary.lessonId),
        ...fragilities,
      ],
    }))
  }

  function handleCreateLesson(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!lessonForm.title.trim() || !lessonForm.discipline.trim() || !lessonForm.date) {
      setActivity('Preencha titulo, disciplina e data para cadastrar a aula')
      return
    }

    const timestamp = new Date().toISOString()
    const lesson: Lesson = {
      id: crypto.randomUUID(),
      title: lessonForm.title.trim(),
      discipline: lessonForm.discipline.trim(),
      date: lessonForm.date,
      recordingReference: lessonForm.recordingReference.trim(),
      notes: lessonForm.notes.trim(),
      status: lessonForm.recordingReference.trim() ? 'recorded' : 'draft',
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    setWorkspace((current) => ({
      ...current,
      lessons: [lesson, ...current.lessons],
    }))
    setSelectedLessonId(lesson.id)
    setLessonForm(emptyLessonForm)
    setActiveModule('aulas')
    setActivity(`Aula criada: ${lesson.title}`)
  }

  function handleSimulateRecording() {
    if (!selectedLesson) {
      setActivity('Selecione uma aula para registrar a gravacao')
      return
    }

    patchLesson(selectedLesson.id, {
      recordingReference:
        selectedLesson.recordingReference || `simulado://gravacoes/${selectedLesson.id}.mp4`,
      status: selectedLesson.status === 'summarized' ? 'summarized' : 'recorded',
    })
    setActivity(`Gravacao registrada para ${selectedLesson.title}`)
  }

  async function handleProcessTranscription() {
    if (!selectedLesson) {
      setActivity('Selecione uma aula antes de processar')
      return
    }

    if (!selectedLesson.recordingReference) {
      setActivity('A aula precisa ter uma referencia de gravacao antes da transcricao')
      return
    }

    setBusyAction('transcribe')
    patchLesson(selectedLesson.id, { status: 'transcribing' })
    setActivity(`Enviando ${selectedLesson.title} para o provedor de transcricao`)

    try {
      const transcript = await requestTranscriptFromProvider({
        ...selectedLesson,
        status: 'transcribing',
      })
      upsertTranscript(transcript)
      patchLesson(selectedLesson.id, { status: 'transcribed' })
      setActivity(`Transcricao concluida para ${selectedLesson.title}`)
      setActiveModule('transcricao')
    } catch {
      patchLesson(selectedLesson.id, { status: 'recorded' })
      setActivity(`Falha ao transcrever ${selectedLesson.title}`)
    } finally {
      setBusyAction(null)
    }
  }

  async function handleGenerateSummary() {
    if (!selectedLesson) {
      setActivity('Selecione uma aula antes de gerar resumo')
      return
    }

    const transcript =
      workspace.transcripts.find((item) => item.lessonId === selectedLesson.id) ?? null

    if (!transcript) {
      setActivity('A aula precisa ter transcricao concluida antes do resumo')
      return
    }

    setBusyAction('summarize')
    patchLesson(selectedLesson.id, { status: 'summarizing' })
    setActivity(`Gerando resumo inteligente para ${selectedLesson.title}`)

    try {
      const result = await requestSummaryFromProvider(selectedLesson, transcript)
      upsertSummary(result.summary, result.fragilities)
      patchLesson(selectedLesson.id, { status: 'summarized' })
      setActivity(`Resumo e fragilidades atualizados para ${selectedLesson.title}`)
      setActiveModule('resumos')
    } catch {
      patchLesson(selectedLesson.id, { status: 'transcribed' })
      setActivity(`Falha ao gerar resumo de ${selectedLesson.title}`)
    } finally {
      setBusyAction(null)
    }
  }

  async function handleRunPipeline() {
    if (!selectedLesson) {
      setActivity('Selecione uma aula para rodar o pipeline')
      return
    }

    setBusyAction('pipeline')
    setActivity(`Pipeline iniciado para ${selectedLesson.title}`)

    try {
      if (!selectedLesson.recordingReference) {
        patchLesson(selectedLesson.id, {
          recordingReference: `simulado://gravacoes/${selectedLesson.id}.mp4`,
          status: 'recorded',
        })
      }

      const lessonWithRecording = {
        ...selectedLesson,
        recordingReference:
          selectedLesson.recordingReference || `simulado://gravacoes/${selectedLesson.id}.mp4`,
      }

      patchLesson(selectedLesson.id, { status: 'transcribing' })
      const transcript = await requestTranscriptFromProvider(lessonWithRecording)
      upsertTranscript(transcript)

      patchLesson(selectedLesson.id, { status: 'summarizing' })
      const result = await requestSummaryFromProvider(lessonWithRecording, transcript)
      upsertSummary(result.summary, result.fragilities)
      patchLesson(selectedLesson.id, { status: 'summarized' })

      setActivity(`Pipeline completo para ${selectedLesson.title}`)
      setActiveModule('fragilidades')
    } catch {
      patchLesson(selectedLesson.id, { status: 'recorded' })
      setActivity(`Falha ao rodar o pipeline de ${selectedLesson.title}`)
    } finally {
      setBusyAction(null)
    }
  }

  function handleCreateMaterial(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!selectedLesson) {
      setActivity('Selecione uma aula antes de adicionar material')
      return
    }

    if (!materialForm.title.trim() || !materialForm.reference.trim()) {
      setActivity('Preencha titulo e referencia do material')
      return
    }

    const material: CourseMaterial = {
      id: crypto.randomUUID(),
      lessonId: selectedLesson.id,
      title: materialForm.title.trim(),
      type: materialForm.type,
      reference: materialForm.reference.trim(),
      done: false,
    }

    setWorkspace((current) => ({
      ...current,
      materials: [material, ...current.materials],
    }))
    setMaterialForm(emptyMaterialForm)
    setActivity(`Material adicionado em ${selectedLesson.title}`)
  }

  function toggleMaterial(materialId: string) {
    setWorkspace((current) => ({
      ...current,
      materials: current.materials.map((material) =>
        material.id === materialId ? { ...material, done: !material.done } : material,
      ),
    }))
    setActivity('Status do item de organizacao atualizado')
  }

  function handleResetDemo() {
    const state = resetWorkspaceState()
    setWorkspace(state)
    setSelectedLessonId(state.lessons[0]?.id ?? '')
    setActivity('Workspace restaurado para o estado inicial da demo')
    setActiveModule('aulas')
  }

  function renderLessonsModule() {
    return (
      <>
        <div className="module-header">
          <div>
            <p className="section-kicker">Aulas</p>
            <h2>Cadastro e historico do curso</h2>
          </div>
          <div className="module-actions">
            <button type="button" className="primary-button" onClick={handleSimulateRecording}>
              Simular gravacao
            </button>
            <button type="button" className="secondary-button" onClick={handleRunPipeline}>
              Rodar pipeline
            </button>
          </div>
        </div>

        <div className="panel-grid">
          <form className="surface-card form-card" onSubmit={handleCreateLesson}>
            <h3>Nova aula</h3>
            <div className="form-grid">
              <label>
                <span>Titulo</span>
                <input
                  value={lessonForm.title}
                  onChange={(event) =>
                    setLessonForm((current) => ({ ...current, title: event.target.value }))
                  }
                  placeholder="Ex.: Introducao a embeddings"
                />
              </label>
              <label>
                <span>Disciplina</span>
                <input
                  value={lessonForm.discipline}
                  onChange={(event) =>
                    setLessonForm((current) => ({ ...current, discipline: event.target.value }))
                  }
                  placeholder="Ex.: NLP"
                />
              </label>
              <label>
                <span>Data</span>
                <input
                  type="date"
                  value={lessonForm.date}
                  onChange={(event) =>
                    setLessonForm((current) => ({ ...current, date: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>Gravacao ou link</span>
                <input
                  value={lessonForm.recordingReference}
                  onChange={(event) =>
                    setLessonForm((current) => ({
                      ...current,
                      recordingReference: event.target.value,
                    }))
                  }
                  placeholder="drive:// ou https://"
                />
              </label>
              <label className="full-width">
                <span>Observacoes</span>
                <textarea
                  value={lessonForm.notes}
                  onChange={(event) =>
                    setLessonForm((current) => ({ ...current, notes: event.target.value }))
                  }
                  placeholder="Topicos, pendencias ou contexto para o resumo"
                  rows={3}
                />
              </label>
            </div>
            <button type="submit" className="primary-button full-width-button">
              Cadastrar aula
            </button>
          </form>

          <div className="surface-card list-card">
            <div className="list-card-header">
              <h3>Biblioteca</h3>
              <span>{workspace.lessons.length} aulas</span>
            </div>
            <div className="stack-list">
              {workspace.lessons.map((lesson) => (
                <button
                  key={lesson.id}
                  type="button"
                  className={selectedLessonId === lesson.id ? 'lesson-row active' : 'lesson-row'}
                  onClick={() => {
                    setSelectedLessonId(lesson.id)
                    setActivity(`Aula selecionada: ${lesson.title}`)
                  }}
                >
                  <div>
                    <strong>{lesson.title}</strong>
                    <p>
                      {lesson.discipline} · {lesson.date}
                    </p>
                  </div>
                  <span className={`badge ${getStatusClass(lesson.status)}`}>
                    {formatStatus(lesson.status)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </>
    )
  }

  function renderTranscriptionModule() {
    return (
      <>
        <div className="module-header">
          <div>
            <p className="section-kicker">Transcricao</p>
            <h2>Fila e resultado do provedor externo</h2>
          </div>
          <div className="module-actions">
            <button
              type="button"
              className="primary-button"
              disabled={busyAction !== null}
              onClick={handleProcessTranscription}
            >
              {busyAction === 'transcribe' ? 'Processando...' : 'Processar aula'}
            </button>
          </div>
        </div>

        <div className="surface-card transcript-card">
          {selectedLesson ? (
            <>
              <div className="list-card-header">
                <h3>{selectedLesson.title}</h3>
                <span>{selectedTranscript?.provider ?? 'Sem transcricao'}</span>
              </div>
              <p className="support-text">
                Status atual: <strong>{formatStatus(selectedLesson.status)}</strong>
              </p>
              <div className="transcript-box">
                {selectedTranscript?.text ?? 'A transcricao ainda nao foi gerada para esta aula.'}
              </div>
            </>
          ) : (
            <p className="empty-state">Selecione uma aula para abrir a transcricao.</p>
          )}
        </div>
      </>
    )
  }

  function renderSummaryModule() {
    return (
      <>
        <div className="module-header">
          <div>
            <p className="section-kicker">Resumos</p>
            <h2>Topicos-chave e proximos passos</h2>
          </div>
          <div className="module-actions">
            <button
              type="button"
              className="primary-button"
              disabled={busyAction !== null}
              onClick={handleGenerateSummary}
            >
              {busyAction === 'summarize' ? 'Gerando...' : 'Gerar resumo'}
            </button>
          </div>
        </div>

        <div className="panel-grid">
          <div className="surface-card summary-section">
            <div className="list-card-header">
              <h3>Visao geral</h3>
              <span>{selectedSummary?.provider ?? 'Sem resumo'}</span>
            </div>
            <p>{selectedSummary?.overview ?? 'A aula ainda nao possui resumo gerado.'}</p>
          </div>
          <div className="surface-card summary-section">
            <h3>Topicos-chave</h3>
            <div className="token-list">
              {(selectedSummary?.topics ?? []).map((topic) => (
                <button
                  key={topic}
                  type="button"
                  className="token-button"
                  onClick={() => setActivity(`Topico destacado: ${topic}`)}
                >
                  {topic}
                </button>
              ))}
              {!selectedSummary && <p className="empty-state">Nenhum topico disponivel.</p>}
            </div>
          </div>
          <div className="surface-card summary-section">
            <h3>Acoes sugeridas</h3>
            <div className="stack-list">
              {(selectedSummary?.actions ?? []).map((action) => (
                <button
                  key={action}
                  type="button"
                  className="inline-action"
                  onClick={() => setActivity(`Acao destacada: ${action}`)}
                >
                  {action}
                </button>
              ))}
              {!selectedSummary && <p className="empty-state">Nenhuma acao sugerida ainda.</p>}
            </div>
          </div>
        </div>
      </>
    )
  }

  function renderFragilitiesModule() {
    return (
      <>
        <div className="module-header">
          <div>
            <p className="section-kicker">Fragilidades</p>
            <h2>Lacunas de estudo e recomendacoes</h2>
          </div>
          <div className="module-actions">
            <button type="button" className="secondary-button" onClick={() => setActiveModule('resumos')}>
              Voltar para resumo
            </button>
          </div>
        </div>

        <div className="stack-list">
          {selectedFragilities.length > 0 ? (
            selectedFragilities.map((fragility) => (
              <button
                key={fragility.id}
                type="button"
                className="surface-card fragility-row"
                onClick={() => setActivity(`Fragilidade revisada: ${fragility.theme}`)}
              >
                <div>
                  <strong>{fragility.theme}</strong>
                  <p>{fragility.recommendation}</p>
                </div>
                <span className={`badge priority-${fragility.priority.toLowerCase()}`}>
                  {fragility.priority}
                </span>
              </button>
            ))
          ) : (
            <div className="surface-card empty-box">
              Nenhuma fragilidade registrada para a aula selecionada.
            </div>
          )}
        </div>
      </>
    )
  }

  function renderOrganizationModule() {
    return (
      <>
        <div className="module-header">
          <div>
            <p className="section-kicker">Organizacao</p>
            <h2>Materiais, links e tarefas do curso</h2>
          </div>
        </div>

        <div className="panel-grid">
          <form className="surface-card form-card" onSubmit={handleCreateMaterial}>
            <h3>Novo item</h3>
            <div className="form-grid">
              <label>
                <span>Titulo</span>
                <input
                  value={materialForm.title}
                  onChange={(event) =>
                    setMaterialForm((current) => ({ ...current, title: event.target.value }))
                  }
                  placeholder="Ex.: Link da aula"
                />
              </label>
              <label>
                <span>Tipo</span>
                <select
                  value={materialForm.type}
                  onChange={(event) =>
                    setMaterialForm((current) => ({
                      ...current,
                      type: event.target.value as MaterialType,
                    }))
                  }
                >
                  <option value="link">Link</option>
                  <option value="task">Tarefa</option>
                  <option value="note">Nota</option>
                </select>
              </label>
              <label className="full-width">
                <span>Referencia</span>
                <input
                  value={materialForm.reference}
                  onChange={(event) =>
                    setMaterialForm((current) => ({ ...current, reference: event.target.value }))
                  }
                  placeholder="URL, tarefa ou observacao"
                />
              </label>
            </div>
            <button type="submit" className="primary-button full-width-button">
              Adicionar ao curso
            </button>
          </form>

          <div className="surface-card list-card">
            <div className="list-card-header">
              <h3>Itens da aula</h3>
              <span>{selectedMaterials.length} itens</span>
            </div>
            <div className="stack-list">
              {selectedMaterials.length > 0 ? (
                selectedMaterials.map((material) => (
                  <button
                    key={material.id}
                    type="button"
                    className={material.done ? 'material-row done' : 'material-row'}
                    onClick={() => toggleMaterial(material.id)}
                  >
                    <div>
                      <strong>{material.title}</strong>
                      <p>
                        {material.type} · {material.reference}
                      </p>
                    </div>
                    <span className="badge neutral">{material.done ? 'Feito' : 'Pendente'}</span>
                  </button>
                ))
              ) : (
                <p className="empty-state">Nenhum item vinculado a esta aula.</p>
              )}
            </div>
          </div>
        </div>
      </>
    )
  }

  function renderModuleContent() {
    switch (activeModule) {
      case 'aulas':
        return renderLessonsModule()
      case 'transcricao':
        return renderTranscriptionModule()
      case 'resumos':
        return renderSummaryModule()
      case 'fragilidades':
        return renderFragilitiesModule()
      case 'organizacao':
        return renderOrganizationModule()
      default:
        return null
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="brand-kicker">FIAPAUTO</p>
          <h1>MVP operacional do curso</h1>
        </div>

        <div className="topbar-actions">
          {modules.map((module) => (
            <button
              key={module.key}
              type="button"
              className={activeModule === module.key ? 'chip-button active' : 'chip-button'}
              onClick={() => {
                setActiveModule(module.key)
                setActivity(`Modulo aberto: ${module.label}`)
              }}
            >
              {module.label}
            </button>
          ))}
        </div>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <div className="sidebar-header">
            <h2>Fluxo</h2>
            <span>demo</span>
          </div>

          <div className="module-list">
            {modules.map((module) => (
              <button
                key={module.key}
                type="button"
                className={activeModule === module.key ? 'module-button active' : 'module-button'}
                onClick={() => {
                  setActiveModule(module.key)
                  setActivity(`Modulo aberto: ${module.label}`)
                }}
              >
                <strong>{module.label}</strong>
                <span>{module.hint}</span>
                <small>{moduleMeta[module.key]}</small>
              </button>
            ))}
          </div>

          <div className="sidebar-summary">
            <button type="button" className="stat-button" onClick={() => setActiveModule('aulas')}>
              <strong>{stats.lessons}</strong>
              <span>Aulas</span>
            </button>
            <button
              type="button"
              className="stat-button"
              onClick={() => setActiveModule('transcricao')}
            >
              <strong>{stats.transcripts}</strong>
              <span>Transcricoes</span>
            </button>
            <button type="button" className="stat-button" onClick={() => setActiveModule('resumos')}>
              <strong>{stats.summaries}</strong>
              <span>Resumos</span>
            </button>
          </div>
        </aside>

        <section className="main-panel">{renderModuleContent()}</section>

        <aside className="detail-panel">
          <div className="detail-card">
            <p className="section-kicker">Aula selecionada</p>
            {selectedLesson ? (
              <>
                <h2>{selectedLesson.title}</h2>
                <p>
                  {selectedLesson.discipline} · {selectedLesson.date}
                </p>
                <span className={`badge ${getStatusClass(selectedLesson.status)}`}>
                  {formatStatus(selectedLesson.status)}
                </span>
                <p>{selectedLesson.notes || 'Sem observacoes adicionais nesta aula.'}</p>
              </>
            ) : (
              <p>Nenhuma aula selecionada.</p>
            )}
          </div>

          <div className="detail-card">
            <p className="section-kicker">Acoes rapidas</p>
            <div className="status-stack">
              <button type="button" className="status-button" onClick={handleSimulateRecording}>
                Registrar gravacao
              </button>
              <button
                type="button"
                className="status-button"
                disabled={busyAction !== null}
                onClick={handleProcessTranscription}
              >
                Transcrever aula
              </button>
              <button
                type="button"
                className="status-button"
                disabled={busyAction !== null}
                onClick={handleGenerateSummary}
              >
                Gerar resumo
              </button>
              <button
                type="button"
                className="status-button"
                disabled={busyAction !== null}
                onClick={handleRunPipeline}
              >
                Rodar tudo
              </button>
              <button type="button" className="status-button" onClick={handleResetDemo}>
                Resetar demo
              </button>
            </div>
          </div>

          <div className="detail-card compact">
            <p className="section-kicker">Atividade</p>
            <strong>{activity}</strong>
          </div>
        </aside>
      </section>
    </main>
  )
}

export default App

import { normalizeLessonTitle } from '../../engineweb/api/botApi.ts'
import type { WorkspaceController } from '../../engineweb/useWorkspaceController.ts'

type AulasViewProps = {
  controller: WorkspaceController
}

export function AulasView({ controller }: AulasViewProps) {
  return (
    <section className="content-grid">
      <article className="panel-card">
        <div className="panel-header"><div><p className="eyebrow">Aulas do bot</p><h2>Gravacoes importadas</h2></div></div>
        <div className="list-column">
          {controller.importedLessons.length > 0 ? controller.importedLessons.map((lesson) => (
            <button key={lesson.id} type="button" className={controller.selectedLesson?.id === lesson.id ? 'lesson-item active' : 'lesson-item'} onClick={() => { controller.setSelectedLessonId(lesson.id); controller.setActivity(`Aula selecionada: ${lesson.title}`) }}>
              <strong>{lesson.title}</strong><span>{lesson.discipline}</span>
            </button>
          )) : <div className="empty-box">Nenhuma aula importada ainda.</div>}
        </div>
      </article>
      <article className="panel-card transcript-panel">
        <div className="panel-header"><div><p className="eyebrow">Transcricao</p><h2>{controller.selectedLesson ? normalizeLessonTitle(controller.selectedLesson.title) : 'Sem aula selecionada'}</h2></div></div>
        <div className="meta-card"><span>Nome da aula gravada</span><strong>{controller.selectedLesson ? normalizeLessonTitle(controller.selectedLesson.title) : 'Aguardando bot'}</strong></div>
        <div className="meta-card transcript-box"><span>Transcricao da aula</span><p>{controller.selectedTranscript?.text ?? 'A transcricao aparecera aqui assim que o bot concluir a gravacao.'}</p></div>
      </article>
    </section>
  )
}

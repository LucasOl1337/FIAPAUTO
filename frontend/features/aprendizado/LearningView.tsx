import { buildBotFileUrl } from '../../engineweb/api/botApi.ts'
import { formatDisplayDateOnly, type WorkspaceController } from '../../engineweb/useWorkspaceController.ts'

type LearningViewProps = {
  controller: WorkspaceController
}

export function LearningView({ controller }: LearningViewProps) {
  const topic = controller.selectedTopic
  const learning = topic?.learning
  const displayDate = formatDisplayDateOnly(
    topic?.dueText,
    ...(topic?.agentMemory?.deadlines ?? []),
  )
  const primaryAttachment = topic?.attachments[0]

  return (
    <section className="panel-card works-shell">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Aprendizado</p>
          <h2>Entenda e resolva a atividade</h2>
        </div>
      </div>

      <section className="topics-rail">
        <div className="topics-header"><strong>Materias extraidas</strong><span>{controller.botState.topics.length} topico(s)</span></div>
        <div className="topics-strip">
          {controller.botState.topics.length > 0 ? controller.botState.topics.map((item) => (
            <button key={item.id} type="button" className={controller.selectedTopicId === item.id ? 'topic-pill active' : 'topic-pill'} onClick={() => { controller.setSelectedTopicId(item.id); controller.setActivity(`Aprendizado aberto para: ${item.title}`) }}>
              <strong>{item.title}</strong><span>{item.course || 'Curso nao identificado'}</span><small>{formatDisplayDateOnly(item.dueText)}</small>
            </button>
          )) : <div className="empty-box">Nenhuma materia extraida ainda.</div>}
        </div>
      </section>

      {topic ? (
        <>
          <div className="topic-hero user-hero">
            <div>
              <p className="eyebrow">Materia selecionada</p>
              <h3>{topic.title}</h3>
              <p className="topic-subtitle">{topic.course || 'Curso nao identificado'} - {displayDate}</p>
            </div>
            {primaryAttachment ? (
              <div className="action-row">
                <a className="primary-button" href={buildBotFileUrl(primaryAttachment.path)} target="_blank" rel="noreferrer">
                  Abrir PDF
                </a>
              </div>
            ) : null}
          </div>

          {learning ? (
            <div className="user-focus-grid">
              <div className="meta-card clean-card user-summary-card">
                <span>Duvidas mais frequentes</span>
                <div className="user-list">
                  {learning.frequentQuestions.map((item) => (
                    <p key={`${item.question}-${item.answer}`}>
                      <strong>{item.question}</strong><br />
                      {item.answer}
                    </p>
                  ))}
                </div>
              </div>
              <div className="meta-card clean-card">
                <span>Conceitos simples</span>
                <div className="user-list">
                  {learning.simpleConcepts.map((item) => (
                    <p key={`${item.title}-${item.content}`}>
                      <strong>{item.title}</strong><br />
                      {item.content}
                    </p>
                  ))}
                </div>
              </div>
              <div className="meta-card clean-card">
                <span>Dicas rapidas</span>
                <div className="user-list">
                  {learning.quickTips.map((item) => <p key={item}>{item}</p>)}
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-box">O aprendizado automatico desta materia ainda nao foi gerado.</div>
          )}
        </>
      ) : (
        <div className="empty-box">Selecione uma materia para ver o aprendizado automatico.</div>
      )}
    </section>
  )
}

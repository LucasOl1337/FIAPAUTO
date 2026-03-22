import type { SubjectTopic } from '../../engineweb/api/botApi.ts'
import type { WorkspaceController } from '../../engineweb/useWorkspaceController.ts'

type LearningViewProps = {
  controller: WorkspaceController
}

export function LearningView({ controller }: LearningViewProps) {
  const topic = controller.selectedTopic
  const learning = normalizeLearningForDisplay(topic)
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
              <strong>{item.title}</strong><span>{item.course || 'Curso nao identificado'}</span>
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
              <p className="topic-subtitle">{topic.course || 'Curso nao identificado'}</p>
            </div>
            {primaryAttachment ? (
              <div className="action-row">
                <a className="primary-button" href={controller.buildAssetUrl(primaryAttachment)} target="_blank" rel="noreferrer">
                  Abrir PDF
                </a>
              </div>
            ) : null}
          </div>

          {learning ? (
            <div className="user-focus-grid learning-clean-grid">
              <div className="meta-card clean-card user-summary-card">
                <span>Duvidas mais frequentes</span>
                <div className="user-list learning-faq-list">
                  {learning.frequentQuestions.map((item) => (
                    <article key={`${item.question}-${item.answer}`} className="learning-faq-item">
                      <strong>{item.question}</strong>
                      <p>{item.answer}</p>
                    </article>
                  ))}
                </div>
              </div>

              <div className="meta-card clean-card learning-topics-card">
                <span>Pontos principais para aprender</span>
                <div className="learning-topic-stack">
                  {learning.learningTopics.map((item) => (
                    <article key={`${item.title}-${item.explanation}`} className="learning-topic-item">
                      <strong>{item.title}</strong>
                      <p>{item.explanation}</p>
                      <p><b>Onde costuma travar:</b> {item.commonDifficulty}</p>
                      <p><b>Como pensar nisso:</b> {item.studyStrategy}</p>
                    </article>
                  ))}
                </div>
              </div>

              <div className="meta-card clean-card learning-tips-card">
                <span>Dicas rapidas</span>
                <div className="assistant-bullet-list">
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

function normalizeLearningForDisplay(topic: SubjectTopic | null) {
  const learning = topic?.learning
  if (!learning) {
    return null
  }

  const learningTopics = (learning.learningTopics ?? []).length > 0
    ? learning.learningTopics
    : (learning.simpleConcepts ?? [])
        .map((item) => ({
          title: cleanDisplayText(item.title, 60),
          explanation: cleanDisplayText(item.content, 240),
          commonDifficulty: 'Uma dificuldade comum e traduzir esse ponto em acao concreta dentro da atividade.',
          studyStrategy: 'Releia o enunciado pensando em como transformar essa ideia em checklist ou etapa de execucao.',
        }))
        .filter((item) => item.title && item.explanation)

  const frequentQuestions = (learning.frequentQuestions ?? [])
    .map((item) => ({
      question: cleanDisplayText(item.question, 90),
      answer: cleanDisplayText(item.answer, 220),
    }))
    .filter((item) => item.question && item.answer && !/\b(prazo|data|horario|deadline)\b/i.test(`${item.question} ${item.answer}`))
    .slice(0, 3)

  const normalizedTopics = learningTopics
    .map((item) => ({
      title: cleanDisplayText(item.title, 60),
      explanation: cleanDisplayText(item.explanation, 240),
      commonDifficulty: cleanDisplayText(item.commonDifficulty, 180),
      studyStrategy: cleanDisplayText(item.studyStrategy, 180),
    }))
    .filter((item) => item.title && item.explanation && item.commonDifficulty && item.studyStrategy)
    .slice(0, 3)

  const quickTips = (learning.quickTips ?? [])
    .map((item) => cleanDisplayText(item, 120))
    .filter((item) => Boolean(item) && !/\b(prazo|data|horario|deadline)\b/i.test(item))
    .slice(0, 3)

  if (frequentQuestions.length === 0 && normalizedTopics.length === 0 && quickTips.length === 0) {
    return null
  }

  return {
    frequentQuestions,
    learningTopics: normalizedTopics,
    quickTips,
  }
}

function cleanDisplayText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized || normalized.length > maxLength) {
    return ''
  }

  if (
    /(teams\.microsoft|status:|curso:|link de detalhe|arquivos baixados|modulo sugerido|titulo:)/i.test(normalized) ||
    /\.(pdf|docx|xlsx|pptx|zip|rar|py)\b/i.test(normalized) ||
    /\b(prazo|data nao identificada|data exata|horario|deadline)\b/i.test(normalized)
  ) {
    return ''
  }

  return normalized
}

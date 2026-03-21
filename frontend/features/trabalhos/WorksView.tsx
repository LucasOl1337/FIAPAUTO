import { buildBotFileUrl } from '../../engineweb/api/botApi.ts'
import {
  buildUserDeliverables,
  cleanTopicDisplayText,
  extractSummarySections,
  formatDisplayDateOnly,
  formatTimestamp,
  safeJson,
  type WorkspaceController,
} from '../../engineweb/useWorkspaceController.ts'

type WorksViewProps = {
  controller: WorkspaceController
}

export function WorksView({ controller }: WorksViewProps) {
  const quickPrompts = [
    'O que preciso entregar?',
    'Qual e o prazo?',
    'Me faca um checklist',
    'Explique este trabalho de forma simples',
    'O que pode me fazer perder pontos?',
  ]
  const topicAnswer = controller.topicAnswer
  const answerNextSteps = topicAnswer?.nextSteps ?? []
  const answerCitations = topicAnswer?.citations ?? []
  const answerSuggestions = topicAnswer?.suggestedQuestions ?? []
  const answerConfidenceLabel =
    topicAnswer?.confidence === 'high'
      ? 'Alta confianca'
      : topicAnswer?.confidence === 'low'
        ? 'Baixa confianca'
        : 'Confianca media'
  const answerSourceLabel =
    topicAnswer?.providerUsed && topicAnswer.providerUsed !== 'local'
      ? 'Resposta gerada com IA em nuvem'
      : 'Resposta guiada pelo material salvo'
  const allSummarySections = extractSummarySections(controller.topicSummary?.summary || controller.selectedTopic?.summary)
  const summarySections = allSummarySections.filter((item) => !/^(prazo|entregaveis?)$/i.test(item.label))
  const userDeliverables = buildUserDeliverables({
    summary: controller.topicSummary?.summary || controller.selectedTopic?.summary,
    attachmentNames: controller.selectedTopic?.attachments.map((item) => item.name),
    memoryDeliverables: controller.selectedTopic?.agentMemory?.deliverables,
  })
  const displayDate = formatDisplayDateOnly(
    controller.selectedTopic?.dueText,
    ...(controller.selectedTopic?.agentMemory?.deadlines ?? []),
    allSummarySections.find((item) => /prazo/i.test(item.label))?.text,
  )
  const primaryAttachment = controller.selectedTopic?.attachments[0] ?? null
  const primaryAttachmentUrl = primaryAttachment ? buildBotFileUrl(primaryAttachment.path) : ''

  return (
    <section className="panel-card works-shell">
      <div className="panel-header">
        <div><p className="eyebrow">Trabalhos</p><h2>{controller.viewMode === 'user' ? 'Suas materias' : 'Workspace por materia'}</h2></div>
        {controller.viewMode === 'admin' ? <div className="workspace-summary"><span>Servico LLM</span><strong>{controller.botState.llm.baseUrl ? `${controller.botState.llm.baseUrl}${controller.botState.llm.model ? ` (${controller.botState.llm.model})` : ''}` : 'Nao configurado'}</strong></div> : null}
      </div>

      <section className="topics-rail">
        <div className="topics-header"><strong>Materias extraidas</strong><span>{controller.botState.topics.length} topico(s)</span></div>
        <div className="topics-strip">
          {controller.botState.topics.length > 0 ? controller.botState.topics.map((topic) => (
            <button key={topic.id} type="button" className={controller.selectedTopicId === topic.id ? 'topic-pill active' : 'topic-pill'} onClick={() => { controller.setSelectedTopicId(topic.id); controller.setActivity(`Materia selecionada: ${topic.title}`) }}>
              <strong>{topic.title}</strong><span>{topic.course || 'Curso nao identificado'}</span><small>{formatDisplayDateOnly(topic.dueText)}</small>
            </button>
          )) : <div className="empty-box">Nenhuma materia extraida ainda.</div>}
        </div>
      </section>

      <div className="works-layout single-column">
        <article className="topic-detail clean">
          {controller.selectedTopic ? (controller.viewMode === 'user' ? (
            <>
              <div className="topic-hero user-hero">
                <div>
                  <p className="eyebrow">Materia selecionada</p>
                  <h3>{controller.selectedTopic.title}</h3>
                  <p className="topic-subtitle">{controller.selectedTopic.course || 'Curso nao identificado'} - {displayDate}</p>
                </div>
                {primaryAttachment ? (
                  <div className="action-row">
                    <a className="primary-button" href={primaryAttachmentUrl} target="_blank" rel="noreferrer">
                      Abrir PDF
                    </a>
                    <a className="secondary-button" href={primaryAttachmentUrl} download={primaryAttachment.name}>
                      Baixar arquivo
                    </a>
                  </div>
                ) : null}
              </div>
              <div className="user-focus-grid">
                <div className="meta-card clean-card user-summary-card">
                  <span>Resumo</span>
                  <div className="user-list">
                    {summarySections.length > 0 ? summarySections.map((item) => (
                      <p key={`${item.label}-${item.text}`}><strong>{item.label}:</strong> {cleanTopicDisplayText(item.text)}</p>
                    )) : <p>Resumo ainda nao disponivel para esta materia.</p>}
                  </div>
                </div>
                <div className="meta-card clean-card user-todo-card">
                  <span>Entregaveis</span>
                  <div className="user-list">
                    {userDeliverables.length > 0 ? userDeliverables.map((item) => <p key={item}>{item}</p>) : <p>Abra o anexo principal e confirme os entregaveis desta materia.</p>}
                  </div>
                </div>
                <div className="meta-card clean-card user-deadline-card">
                  <span>Prazo</span>
                  <div className="user-list">
                    <p>{displayDate}</p>
                  </div>
                </div>
                <div className="meta-card clean-card user-files-card">
                  <span>Arquivos</span>
                  <div className="user-list">
                    {primaryAttachment ? <p>Abra ou baixe o PDF principal com um clique.</p> : <p>Nenhum anexo registrado.</p>}
                  </div>
                  <div className="download-list">
                    {controller.selectedTopic.attachments.length > 0 ? controller.selectedTopic.attachments.slice(0, 3).map((attachment) => <a key={attachment.path} className="download-chip" href={buildBotFileUrl(attachment.path)} target="_blank" rel="noreferrer">{attachment.name}</a>) : null}
                  </div>
                </div>
              </div>
              <div className="meta-card clean-card user-ask-card">
                <span>Pergunte sobre esta materia</span>
                <div className="chip-row">
                  {quickPrompts.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="download-chip"
                      onClick={() => controller.setTopicQuestion(prompt)}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
                <textarea value={controller.topicQuestion} onChange={(event) => controller.setTopicQuestion(event.target.value)} placeholder="Ex.: o que preciso entregar? qual parte merece mais atencao?" rows={3} />
                <div className="action-row"><button type="button" className="primary-button" disabled={controller.topicBusy !== null} onClick={() => void controller.handleAskTopic()}>{controller.topicBusy === 'ask' ? 'Perguntando...' : 'Perguntar ao agente'}</button></div>
                <p className="rich-paragraph">{topicAnswer?.answer || 'A resposta contextual do agente aparecera aqui.'}</p>
                {topicAnswer ? (
                  <div className="user-focus-grid">
                    <div className="meta-card clean-card">
                      <span>Leitura rapida</span>
                      <div className="user-list">
                        <p>{answerSourceLabel}</p>
                        <p>{answerConfidenceLabel}</p>
                        {topicAnswer.providerUsed === 'local' ? <p>O sistema respondeu com base no material salvo desta materia.</p> : <p>O sistema usou um modelo em nuvem para deixar a resposta mais natural.</p>}
                      </div>
                    </div>
                    <div className="meta-card clean-card">
                      <span>O que fazer agora</span>
                      <div className="user-list">
                        {answerNextSteps.length > 0 ? answerNextSteps.slice(0, 3).map((step) => <p key={step}>{step}</p>) : <p>Se quiser, pergunte sobre prazo, entregaveis ou checklist.</p>}
                      </div>
                    </div>
                    <div className="meta-card clean-card">
                      <span>Perguntas que ajudam</span>
                      <div className="user-list">
                        {answerSuggestions.length > 0 ? answerSuggestions.slice(0, 3).map((item) => <p key={item}>{item}</p>) : <p>Tente perguntar de forma mais objetiva sobre o trabalho.</p>}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div className="topic-hero">
                <div>
                  <p className="eyebrow">Materia selecionada</p>
                  <h3>{controller.selectedTopic.title}</h3>
                  <p className="topic-subtitle">{controller.selectedTopic.course || 'Curso nao identificado'} - {displayDate} - {controller.selectedTopic.status}</p>
                  <div className="topic-badges inline">
                    <span className="topic-badge">{controller.selectedTopic.moduleKey}</span>
                    <span className="topic-badge">{controller.selectedTopic.summaryGeneratedAt ? 'Resumo salvo' : 'Sem resumo'}</span>
                    <span className="topic-badge">{controller.selectedTopic.agentMemoryGeneratedAt ? 'Agente pronto' : 'Memoria pendente'}</span>
                  </div>
                </div>
                <div className="action-row">
                  <button type="button" className="secondary-button" disabled={controller.topicBusy !== null} onClick={() => void controller.handleGenerateSummary(true)}>{controller.topicBusy === 'summary' ? 'Gerando resumo...' : controller.selectedTopic.summary ? 'Regenerar resumo' : 'Gerar resumo'}</button>
                  <button type="button" className="primary-button" disabled={controller.topicBusy !== null} onClick={() => void controller.handleGenerateMemory(true)}>{controller.topicBusy === 'memory' ? 'Gerando memoria...' : controller.selectedTopic.agentMemory ? 'Regenerar agente' : 'Gerar agente'}</button>
                </div>
              </div>
              <div className="topic-main-grid">
                <section className="topic-visual-panel">
                  <div className="section-heading"><strong>Screenshot da lista real</strong><span>{controller.selectedTopic.screenshots.length > 0 ? `${controller.selectedTopic.screenshots.length} captura(s)` : 'Sem captura ainda'}</span></div>
                  <div className="screenshot-frame">{controller.selectedTopic.screenshots[0] ? <img src={buildBotFileUrl(controller.selectedTopic.screenshots[0])} alt={`Screenshot do topico ${controller.selectedTopic.title}`} className="topic-screenshot" /> : <div className="empty-box">Ainda nao existe screenshot vinculada a este topico.</div>}</div>
                </section>
                <section className="topic-info-stack">
                  <div className="meta-card clean-card"><span>Resumo persistido</span><p className="rich-paragraph">{controller.topicSummary?.summary || controller.selectedTopic.summary || 'Este topico ainda nao tem resumo salvo.'}</p></div>
                  <div className="meta-card clean-card"><span>Anexos e conteudo isolado</span><div className="download-list">{controller.selectedTopic.attachments.length > 0 ? controller.selectedTopic.attachments.map((attachment) => <a key={attachment.path} className="download-chip" href={buildBotFileUrl(attachment.path)} target="_blank" rel="noreferrer">{attachment.name}</a>) : <span className="placeholder-text">Nenhum anexo registrado neste topico.</span>}</div><pre className="content-preview">{controller.selectedTopic.contentText || 'Conteudo textual ainda nao consolidado.'}</pre></div>
                </section>
              </div>
              <div className="topic-agent-grid">
                <div className="meta-card transcript-box clean-card">
                  <span>Agente da materia</span>
                  <p className="rich-paragraph">{controller.selectedTopic.agentMemory?.overview || 'A memoria persistida ainda nao foi gerada para este topico.'}</p>
                  <div className="chip-row">{(controller.selectedTopic.agentMemory?.deliverables || []).map((item) => <span key={item} className="info-chip">{item}</span>)}</div>
                  <div className="chip-row">
                    {quickPrompts.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        className="download-chip"
                        onClick={() => controller.setTopicQuestion(prompt)}
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                  <textarea value={controller.topicQuestion} onChange={(event) => controller.setTopicQuestion(event.target.value)} placeholder="Ex.: o que preciso entregar? qual parte merece mais atencao?" rows={4} />
                  <div className="action-row">
                    <button type="button" className="primary-button" disabled={controller.topicBusy !== null} onClick={() => void controller.handleAskTopic()}>{controller.topicBusy === 'ask' ? 'Perguntando...' : 'Perguntar ao agente'}</button>
                    <button type="button" className="secondary-button" disabled={controller.topicBusy !== null} onClick={() => void controller.handleGenerateMemory(false)}>Atualizar memoria salva</button>
                  </div>
                  <p className="rich-paragraph">{topicAnswer?.answer || 'A resposta contextual do agente aparecera aqui.'}</p>
                  {topicAnswer ? (
                    <div className="user-focus-grid">
                      <div className="meta-card clean-card">
                        <span>Sinais da resposta</span>
                        <div className="user-list">
                          <p>Confianca: {topicAnswer.confidence || 'medium'}</p>
                          <p>Estrategia: {topicAnswer.strategyUsed || 'memory'}</p>
                          <p>Fallback: nivel {topicAnswer.fallbackLevel ?? 0}</p>
                          <p>Provedor: {topicAnswer.providerUsed || 'local'}</p>
                        </div>
                      </div>
                      <div className="meta-card clean-card">
                        <span>Proximos passos</span>
                        <div className="user-list">
                          {answerNextSteps.length > 0 ? answerNextSteps.map((step) => <p key={step}>{step}</p>) : <p>Nenhum proximo passo sugerido.</p>}
                        </div>
                      </div>
                      <div className="meta-card clean-card">
                        <span>Baseado em</span>
                        <div className="user-list">
                          {answerCitations.length > 0 ? answerCitations.slice(0, 3).map((citation) => <p key={`${citation.sourceType}-${citation.snippet}`}>{citation.sourceLabel}: {citation.snippet}</p>) : <p>Nenhuma citacao registrada.</p>}
                        </div>
                      </div>
                      <div className="meta-card clean-card">
                        <span>Perguntas sugeridas</span>
                        <div className="user-list">
                          {answerSuggestions.length > 0 ? answerSuggestions.map((item) => <p key={item}>{item}</p>) : <p>Nenhuma pergunta sugerida.</p>}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="meta-card transcript-box clean-card">
                  <span>Debug do topico</span>
                  <div className="log-lines tall">{controller.topicDebugEvents.length > 0 ? controller.topicDebugEvents.map((event) => <code key={event.id} className="log-line">[{formatTimestamp(event.ts)}] {event.endpoint} topic={event.topicId || 'sem-topico'} status={event.statusCode} duracao={event.durationMs}ms{event.error ? ` erro=${event.error}` : ''}{'\n'}request={safeJson(event.request)}{'\n'}response={safeJson(event.response)}</code>) : <span className="placeholder-text">Nenhum evento do LLM foi registrado para este topico ainda.</span>}</div>
                </div>
              </div>
            </>
          )) : <div className="empty-box">{controller.topicBusy === 'detail' ? 'Carregando detalhes do topico...' : 'Selecione uma materia na faixa superior para abrir o conteudo.'}</div>}
        </article>
      </div>
    </section>
  )
}

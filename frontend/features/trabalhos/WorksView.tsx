import {
  buildUserDeliverables,
  cleanTopicDisplayText,
  extractSummarySections,
  formatTimestamp,
  safeJson,
  truncateText,
  type WorkspaceController,
} from '../../engineweb/useWorkspaceController.ts'

type WorksViewProps = {
  controller: WorkspaceController
}

export function WorksView({ controller }: WorksViewProps) {
  const quickPrompts = [
    'O que preciso entregar?',
    'Me faca um checklist',
    'Explique este trabalho de forma simples',
    'O que pode me fazer perder pontos?',
  ]
  const topicAnswer = controller.topicAnswer
  const answerSections = topicAnswer?.sections
  const answerNextSteps = topicAnswer?.nextSteps ?? []
  const answerCitations = topicAnswer?.citations ?? []
  const answerSuggestions = answerSections?.followUpQuestions ?? topicAnswer?.suggestedQuestions ?? []
  const answerSourceLabel = answerSections?.answerMode === 'general_guidance' ? 'Explicacao complementar' : 'Baseada na materia'
  const allSummarySections = extractSummarySections(controller.topicSummary?.summary || controller.selectedTopic?.summary)
  const summarySections = allSummarySections.filter((item) => !/^(prazo|entregaveis?)$/i.test(item.label))
  const userDeliverables = buildUserDeliverables({
    summary: controller.topicSummary?.summary || controller.selectedTopic?.summary,
    attachmentNames: controller.selectedTopic?.attachments.map((item) => item.name),
    memoryDeliverables: controller.selectedTopic?.agentMemory?.deliverables,
  })
  const primaryAttachment = controller.selectedTopic?.attachments[0] ?? null
  const primaryAttachmentUrl = primaryAttachment ? controller.buildAssetUrl(primaryAttachment) : ''
  const parsedAnswer = parseAssistantAnswer(topicAnswer?.answer)
  const attentionItems = buildAttentionItems(
    parsedAnswer.attention,
    controller.selectedTopic?.agentMemory?.keyFacts ?? [],
    controller.selectedTopic?.summary ?? '',
  )
  const fullAnswerItems = compactAnswerItems(answerSections?.fullAnswer ?? buildFullAnswerItems(parsedAnswer), 4, 220)
  const deliverableItems = compactAnswerItems(answerSections?.deliverables ?? (parsedAnswer.deliverables.length > 0 ? parsedAnswer.deliverables : userDeliverables), 3, 72)
  const nextActionItems = compactAnswerItems(answerSections?.nextSteps ?? (parsedAnswer.nextSteps.length > 0 ? parsedAnswer.nextSteps : answerNextSteps), 3, 76)
  const suggestionItems = compactAnswerItems(answerSuggestions, 3, 58)
  const sourcePreviewItems = compactAnswerItems(answerCitations.map((citation) => `${citation.sourceLabel}: ${sanitizeAssistantText(citation.snippet)}`), 2, 150)
  const compactDirect = truncateText(answerSections?.summary10s ?? parsedAnswer.direct, 160)
  const compactAttention = compactAnswerItems(answerSections?.attentionPoints ?? expandAnswerBullets(attentionItems), 4, 96)

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
              <strong>{topic.title}</strong><span>{topic.course || 'Curso nao identificado'}</span>
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
                  <p className="topic-subtitle">{controller.selectedTopic.course || 'Curso nao identificado'}</p>
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
                <div className="meta-card clean-card user-files-card">
                  <span>Arquivos</span>
                  <div className="user-list">
                    {primaryAttachment ? <p>Abra ou baixe o PDF principal com um clique.</p> : <p>Nenhum anexo registrado.</p>}
                  </div>
                  <div className="download-list">
                    {controller.selectedTopic.attachments.length > 0 ? controller.selectedTopic.attachments.slice(0, 3).map((attachment) => <a key={attachment.path} className="download-chip" href={controller.buildAssetUrl(attachment)} target="_blank" rel="noreferrer">{attachment.name}</a>) : null}
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
                {topicAnswer ? (
                  <div className="assistant-answer-shell">
                    <div className="assistant-answer-topbar">
                      <div className="assistant-answer-callout">
                        <span>Resumo em 10 segundos</span>
                        <strong>{compactDirect}</strong>
                      </div>
                      <div className="assistant-answer-badges">
                        <span className="info-chip">{answerSourceLabel}</span>
                      </div>
                    </div>
                    <div className="meta-card clean-card assistant-full-answer-card">
                      <span>Resposta completa</span>
                      <div className="assistant-bullet-list prose">
                        {fullAnswerItems.length > 0 ? fullAnswerItems.map((item) => <p key={item}>{item}</p>) : <p>O agente respondera aqui com mais contexto.</p>}
                      </div>
                    </div>
                    <div className="assistant-compact-grid">
                      <div className="meta-card clean-card assistant-brief-card">
                        <span>O que entregar</span>
                        <div className="assistant-bullet-list">
                          {deliverableItems.length > 0 ? deliverableItems.map((item) => <p key={item}>{item}</p>) : <p>Abra o anexo principal e confirme o que precisa ser enviado.</p>}
                        </div>
                      </div>
                      <div className="meta-card clean-card assistant-brief-card warning">
                        <span>Ponto de atencao</span>
                        <div className="assistant-bullet-list">
                          {compactAttention.length > 0 ? compactAttention.map((item) => <p key={item}>{item}</p>) : <p>Nao encontrei um risco especifico no material.</p>}
                        </div>
                      </div>
                      <div className="meta-card clean-card assistant-brief-card success">
                        <span>Proximo passo</span>
                        <div className="assistant-bullet-list">
                          {nextActionItems.length > 0 ? nextActionItems.map((item) => <p key={item}>{item}</p>) : <p>Pergunte sobre entrega, checklist ou criterios para afunilar a resposta.</p>}
                        </div>
                      </div>
                    </div>
                    <div className="assistant-inline-footer">
                      {suggestionItems.length > 0 ? (
                        <div className="assistant-inline-block">
                          <span>Perguntas seguintes</span>
                          <div className="chip-row">
                            {suggestionItems.map((item) => (
                              <button
                                key={item}
                                type="button"
                                className="download-chip"
                                onClick={() => controller.setTopicQuestion(item)}
                              >
                                {item}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {sourcePreviewItems.length > 0 ? (
                        <details className="assistant-details">
                          <summary>Ver base da resposta</summary>
                          <div className="assistant-bullet-list compact">
                            {sourcePreviewItems.map((item) => <p key={item}>{item}</p>)}
                          </div>
                        </details>
                      ) : null}
                    </div>
                  </div>
                ) : <p className="rich-paragraph">A resposta contextual do agente aparecera aqui.</p>}
                {topicAnswer ? (
                  <div className="user-focus-grid">
                    <div className="meta-card clean-card">
                      <span>Como o sistema respondeu</span>
                      <div className="user-list">
                        <p>{answerSourceLabel}</p>
                        {answerSections?.answerMode === 'general_guidance' ? <p>O sistema conectou sua duvida com a materia e complementou a explicacao.</p> : <p>O sistema respondeu com base no material salvo desta materia.</p>}
                      </div>
                    </div>
                    <div className="meta-card clean-card">
                      <span>Proxima pergunta util</span>
                      <div className="user-list">
                        {suggestionItems.length > 0 ? suggestionItems.map((item) => <p key={item}>{item}</p>) : <p>Se quiser, pergunte sobre entregaveis, checklist ou criterios.</p>}
                      </div>
                    </div>
                    <div className="meta-card clean-card">
                      <span>Proximo passo recomendado</span>
                      <div className="user-list">
                        {nextActionItems.length > 0 ? nextActionItems.map((step) => <p key={step}>{step}</p>) : <p>Tente perguntar de forma mais objetiva sobre o trabalho.</p>}
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
                  <p className="topic-subtitle">{controller.selectedTopic.course || 'Curso nao identificado'} - {controller.selectedTopic.status}</p>
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
                  <div className="screenshot-frame">{controller.selectedTopic.screenshots[0] ? <img src={controller.buildAssetUrl(controller.selectedTopic.screenshots[0])} alt={`Screenshot do topico ${controller.selectedTopic.title}`} className="topic-screenshot" /> : <div className="empty-box">Ainda nao existe screenshot vinculada a este topico.</div>}</div>
                </section>
                <section className="topic-info-stack">
                  <div className="meta-card clean-card"><span>Resumo persistido</span><p className="rich-paragraph">{controller.topicSummary?.summary || controller.selectedTopic.summary || 'Este topico ainda nao tem resumo salvo.'}</p></div>
                  <div className="meta-card clean-card"><span>Anexos e conteudo isolado</span><div className="download-list">{controller.selectedTopic.attachments.length > 0 ? controller.selectedTopic.attachments.map((attachment) => <a key={attachment.path} className="download-chip" href={controller.buildAssetUrl(attachment)} target="_blank" rel="noreferrer">{attachment.name}</a>) : <span className="placeholder-text">Nenhum anexo registrado neste topico.</span>}</div><pre className="content-preview">{controller.selectedTopic.contentText || 'Conteudo textual ainda nao consolidado.'}</pre></div>
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
                  <div className="user-focus-grid">
                    <div className="meta-card clean-card">
                      <span>Decisao da biblioteca</span>
                      <div className="user-list">
                        <p>{controller.topicLibraryDecision?.summary || 'Nenhuma analise de biblioteca disponivel ainda.'}</p>
                        <p>Pergunta analisada: {controller.topicLibraryDecision?.question || 'Nenhuma pergunta recente.'}</p>
                        <p>Considerados: {controller.topicLibraryDecision?.considered ?? 0}</p>
                        <p>Aceitos: {controller.topicLibraryDecision?.accepted ?? 0}</p>
                        <p>Descartados: {controller.topicLibraryDecision?.rejected ?? 0}</p>
                      </div>
                    </div>
                    <div className="meta-card clean-card">
                      <span>Top matches da biblioteca</span>
                      <div className="user-list">
                        {controller.topicLibraryMatches.length > 0 ? controller.topicLibraryMatches.slice(0, 5).map((match) => (
                          <p key={match.id}>
                            <strong>{match.topicTitle}</strong> [{match.sourceType}] score={match.score} {match.usedInAnswer ? 'usado' : 'descartado'}: {truncateText(match.reason, 120)}
                          </p>
                        )) : <p>Nenhum caso parecido foi ranqueado ainda.</p>}
                      </div>
                    </div>
                    <div className="meta-card clean-card">
                      <span>Respostas validadas salvas</span>
                      <div className="user-list">
                        {controller.validatedAnswerCandidates.length > 0 ? controller.validatedAnswerCandidates.slice(0, 4).map((entry) => (
                          <p key={entry.id}>
                            <strong>{entry.question}</strong> grounding={entry.groundingScore} citacoes={entry.citations.length}
                          </p>
                        )) : <p>Nenhuma resposta validada foi salva para este topico ainda.</p>}
                      </div>
                    </div>
                  </div>
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

type ParsedAssistantAnswer = {
  direct: string
  deliverables: string[]
  attention: string[]
  nextSteps: string[]
  extra: string[]
}

function parseAssistantAnswer(answer: string | undefined): ParsedAssistantAnswer {
  const lines = (answer ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)

  const parsed: ParsedAssistantAnswer = {
    direct: '',
    deliverables: [],
    attention: [],
    nextSteps: [],
    extra: [],
  }

  let currentSection: keyof ParsedAssistantAnswer | null = null

  for (const line of lines) {
    const sectionMatch = line.match(/^([A-Za-z\s]+):\s*(.*)$/)
    if (sectionMatch) {
      const sectionKey = normalizeAssistantSection(sectionMatch[1] ?? '')
      if (sectionKey) {
        currentSection = sectionKey
        const inlineValue = sectionMatch[2]?.trim()
        if (inlineValue) {
          pushAssistantValue(parsed, sectionKey, inlineValue)
        }
        continue
      }
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)$/)
    if (bulletMatch && currentSection) {
      pushAssistantValue(parsed, currentSection, bulletMatch[1] ?? '')
      continue
    }

    if (currentSection) {
      pushAssistantValue(parsed, currentSection, line)
      continue
    }

    const cleanedLine = sanitizeAssistantText(line)
    if (cleanedLine) {
      parsed.extra.push(cleanedLine)
    }
  }

  const fallbackDirect = parsed.extra[0] || sanitizeAssistantText(answer ?? '') || 'A resposta contextual do agente aparecera aqui.'
  parsed.direct = parsed.direct || fallbackDirect
  if (parsed.extra.length > 0 && parsed.extra[0] === parsed.direct) {
    parsed.extra = parsed.extra.slice(1)
  }

  return parsed
}

function normalizeAssistantSection(value: string) {
  const normalized = value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()

  if (/^resposta direta|^resumo rapido|^resumo em 10 segundos/.test(normalized)) return 'direct' satisfies keyof ParsedAssistantAnswer
  if (/^o que entregar|^entrega|^entregaveis?/.test(normalized)) return 'deliverables' satisfies keyof ParsedAssistantAnswer
  if (/^atencao|^pontos? de atencao|^riscos?/.test(normalized)) return 'attention' satisfies keyof ParsedAssistantAnswer
  if (/^como fazer|^como comecar|^comece assim/.test(normalized)) return 'nextSteps' satisfies keyof ParsedAssistantAnswer
  if (/^proximo passo|^proximos passos|^checklist/.test(normalized)) return 'nextSteps' satisfies keyof ParsedAssistantAnswer

  return null
}

function pushAssistantValue(parsed: ParsedAssistantAnswer, key: keyof ParsedAssistantAnswer, value: string) {
  const cleaned = sanitizeAssistantText(value)
  if (!cleaned) {
    return
  }

  if (key === 'direct') {
    parsed.direct = parsed.direct ? `${parsed.direct} ${cleaned}`.trim() : cleaned
    return
  }

  const bucket = parsed[key]
  if (Array.isArray(bucket) && !bucket.includes(cleaned)) {
    bucket.push(cleaned)
  }
}

function buildAttentionItems(answerAttention: string[], keyFacts: string[], summary: string) {
  if (answerAttention.length > 0) {
    return answerAttention
  }

  const factMatches = keyFacts.filter((item) => /atras|atenc|maximo|zero|abnt|sem dados|ausencia|cancela|nota|penalidade|link/i.test(item))
  if (factMatches.length > 0) {
    return factMatches
  }

  const summaryMatches = summary
    .split(/[.\n]+/)
    .map((item) => item.trim())
    .filter((item) => /atras|atenc|maximo|zero|abnt|sem dados|ausencia|cancela|nota|penalidade|link/i.test(item))

  return summaryMatches.slice(0, 3)
}

function buildFullAnswerItems(answer: ParsedAssistantAnswer) {
  const items = [
    sanitizeAssistantText(answer.direct),
    ...answer.extra.map((item) => sanitizeAssistantText(item)),
  ].filter(Boolean)

  return dedupeAssistantItems(items).slice(0, 4)
}

function expandAnswerBullets(items: string[]) {
  const parts = items.flatMap((item) =>
    sanitizeAssistantText(item)
      .replace(/^(pontos?\s+de\s+atencao|atencao)\s*:\s*/i, '')
      .split(/\s*;\s*|\.\s+(?=[A-ZÀ-ÿ0-9-])/)
      .map((part) => sanitizeAssistantText(part))
      .filter(Boolean),
  )

  return dedupeAssistantItems(parts)
}

function compactAnswerItems(items: string[], limit: number, maxLength: number) {
  return items
    .map((item) => sanitizeAssistantText(item))
    .filter(Boolean)
    .filter((item, index, array) => array.findIndex((candidate) => candidate.toLowerCase() === item.toLowerCase()) === index)
    .slice(0, limit)
    .map((item) => truncateText(item, maxLength))
}

function dedupeAssistantItems(items: string[]) {
  return items.filter((item, index, array) => array.findIndex((candidate) => candidate.toLowerCase() === item.toLowerCase()) === index)
}

function sanitizeAssistantText(value: string) {
  const withoutMarkdown =
    value
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/^>\s*/g, '')
      .replace(/^#{1,6}\s*/g, '')
      .replace(/^\|+|\|+$/g, '')
      .replace(/\s*\|\s*/g, ' - ')
      .replace(/^-{3,}$/g, '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()

  if (!withoutMarkdown || /^[- ]+$/.test(withoutMarkdown) || /^[- ]+ - /.test(withoutMarkdown)) {
    return ''
  }

  return withoutMarkdown
}

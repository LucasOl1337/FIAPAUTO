import fs from 'node:fs/promises'
import path from 'node:path'
import { runtimePaths } from '../config/runtimePaths.ts'
import { routeAssistantChat, type ProviderChatResponse } from '../connections/llm/providerRouter.ts'
import { classifyQuestionIntent, type QuestionIntent } from '../engine/questionIntentClassifier.ts'
import type { PublicChatResponse, PublicTopic, PublishedKnowledgeChunk } from '../apis/contracts/index.ts'

type Citation = PublicChatResponse['citations'][number]

type ParsedStructuredAnswer = {
  direct: string
  deliverables: string[]
  attention: string[]
  nextSteps: string[]
  extra: string[]
}

type QualityEvaluation = {
  accepted: boolean
  reason: string
  missingSections: string[]
}

type DeterministicPackage = {
  answer: string
  deliverables: string[]
  attention: string[]
  nextSteps: string[]
}

type ToolUsageContext = {
  toolLabel: string
  toolKey: string
  hasMentionInContext: boolean
  hasExplicitRequirement: boolean
}

export async function answerPublishedTopicQuestion(input: {
  topic: PublicTopic
  chunks: PublishedKnowledgeChunk[]
  question: string
}) {
  const intent = classifyQuestionIntent(input.question)
  const scopedChunks = input.chunks.filter((chunk) => chunk.topicId === input.topic.id)
  const rankedChunks = rankChunks(scopedChunks, input.question, intent)
  const citations = rankedChunks.slice(0, 3).map((chunk) => ({
    sourceType: chunk.sourceType === 'overview' ? 'summary' : chunk.sourceType,
    sourceLabel: `${input.topic.title} / ${chunk.sourceType}`,
    snippet: chunk.text,
  })) satisfies Citation[]
  const deterministic = buildDeterministicPackage({
    topic: input.topic,
    question: input.question,
    citations,
    intent,
  })
  const confidence = citations.length >= 2 ? 'high' : citations.length === 1 ? 'medium' : 'low'
  const prompt = buildPrompt({
    topic: input.topic,
    question: input.question,
    rankedChunks: rankedChunks.slice(0, 6),
    intent,
  })
  const documents = buildDocuments(input.topic, citations)
  const images = shouldAttachTopicImages(input.question) ? await readTopicImages(input.topic) : []

  try {
    const primary = await routeAssistantChat({
      jobId: `public-topic-ask-${input.topic.id}-${Date.now()}`,
      topicId: input.topic.id,
      prompt,
      documents,
      images,
    })

    const primaryPayload = buildProviderPayload({
      input,
      citations,
      confidence,
      intent,
      providerResponse: primary,
      answer: primary.answer,
      qualityStatus: 'accepted',
      answeredByPass: 'primary',
    })

    if (primaryPayload.qualityStatus !== 'accepted') {
      const retryPrompt = buildRetryPrompt({
        topic: input.topic,
        question: input.question,
        intent,
        previousAnswer: primary.answer,
        qualityReason: primaryPayload.qualityReason,
        missingSections: primaryPayload.missingSections ?? [],
        rankedChunks: rankedChunks.slice(0, 6),
      })

      try {
        const retry = await routeAssistantChat({
          jobId: `public-topic-ask-retry-${input.topic.id}-${Date.now()}`,
          topicId: input.topic.id,
          prompt: retryPrompt,
          documents,
          images,
        })

        const retryPayload = buildProviderPayload({
          input,
          citations,
          confidence,
          intent,
          providerResponse: retry,
          answer: retry.answer,
          qualityStatus: 'regenerated',
          answeredByPass: 'retry',
        })

        if (retryPayload.qualityStatus !== 'fallback') {
          return retryPayload
        }

        return buildFallbackPayload({
          input,
          citations,
          confidence,
          deterministic,
          reason: retryPayload.qualityReason,
          missingSections: retryPayload.missingSections,
        })
      } catch {
        return buildFallbackPayload({
          input,
          citations,
          confidence,
          deterministic,
          reason: primaryPayload.qualityReason,
          missingSections: primaryPayload.missingSections,
        })
      }
    }

    return primaryPayload
  } catch {
    return buildFallbackPayload({
      input,
      citations,
      confidence,
      deterministic,
      reason: 'A resposta da IA falhou ou ficou insuficiente; usamos o fallback local.',
    })
  }
}

function buildProviderPayload(input: {
  input: { topic: PublicTopic; question: string }
  citations: Citation[]
  confidence: PublicChatResponse['confidence']
  intent: QuestionIntent
  providerResponse: ProviderChatResponse
  answer: string
  qualityStatus: 'accepted' | 'regenerated'
  answeredByPass: 'primary' | 'retry'
}) {
  const parsed = parseStructuredAnswer(input.answer)
  const evaluation = evaluateAnswerQuality({
    question: input.input.question,
    topic: input.input.topic,
    intent: input.intent,
    parsed,
    citations: input.citations,
  })

  if (!evaluation.accepted) {
    const nextSteps = buildActionableSteps({
      topic: input.input.topic,
      question: input.input.question,
      intent: input.intent,
      citations: input.citations,
    })
    return {
      topicId: input.input.topic.id,
      answer: input.answer,
      sections: buildResponseSections({
        summary10s: parsed.direct,
        fullAnswer: [sanitizeAnswerText(input.answer)],
        deliverables: parsed.deliverables,
        attentionPoints: parsed.attention,
        nextSteps,
        followUpQuestions: buildSuggestedQuestions(input.intent),
      }),
      confidence: input.confidence,
      strategyUsed: input.providerResponse.strategyUsed,
      providerUsed: input.providerResponse.providerUsed,
      fallbackLevel: input.providerResponse.fallbackLevel,
      citations: input.citations,
      suggestedQuestions: buildSuggestedQuestions(input.intent),
      nextSteps,
      answeredAt: new Date().toISOString(),
      qualityStatus: 'fallback',
      qualityReason: evaluation.reason,
      answeredByPass: input.answeredByPass,
      missingSections: evaluation.missingSections,
    } satisfies PublicChatResponse
  }

  const nextSteps = parsed.nextSteps.length > 0
    ? parsed.nextSteps.slice(0, 3)
    : buildActionableSteps({
      topic: input.input.topic,
      question: input.input.question,
      intent: input.intent,
      citations: input.citations,
    })
  const formattedAnswer = formatStructuredAnswer({
    direct: parsed.direct,
    deliverables: parsed.deliverables,
    attention: parsed.attention,
    nextSteps: parsed.nextSteps,
  })
  return {
    topicId: input.input.topic.id,
    answer: formattedAnswer,
    sections: buildResponseSections({
      summary10s: parsed.direct,
      fullAnswer: [sanitizeAnswerText(parsed.direct)],
      deliverables: parsed.deliverables,
      attentionPoints: parsed.attention,
      nextSteps,
      followUpQuestions: buildSuggestedQuestions(input.intent),
    }),
    confidence: input.confidence,
    strategyUsed: input.providerResponse.strategyUsed,
    providerUsed: input.providerResponse.providerUsed,
    fallbackLevel: input.providerResponse.fallbackLevel,
    citations: input.citations,
    suggestedQuestions: buildSuggestedQuestions(input.intent),
    nextSteps,
    answeredAt: new Date().toISOString(),
    qualityStatus: input.qualityStatus,
    qualityReason: evaluation.reason,
    answeredByPass: input.answeredByPass,
    missingSections: evaluation.missingSections,
  } satisfies PublicChatResponse
}

function buildFallbackPayload(input: {
  input: { topic: PublicTopic; question: string }
  citations: Citation[]
  confidence: PublicChatResponse['confidence']
  deterministic: DeterministicPackage
  reason: string
  missingSections?: string[]
}) {
  return {
    topicId: input.input.topic.id,
    answer: input.deterministic.answer,
    sections: buildResponseSections({
      summary10s: extractSectionSummary(input.deterministic.answer),
      fullAnswer: [sanitizeAnswerText(input.deterministic.answer)],
      deliverables: input.deterministic.deliverables,
      attentionPoints: input.deterministic.attention,
      nextSteps: input.deterministic.nextSteps,
      followUpQuestions: buildSuggestedQuestions(classifyQuestionIntent(input.input.question)),
    }),
    confidence: input.confidence,
    strategyUsed: input.input.topic.agentMemory ? 'memory' : 'deterministic',
    providerUsed: 'local',
    fallbackLevel: 2,
    citations: input.citations,
    suggestedQuestions: buildSuggestedQuestions(classifyQuestionIntent(input.input.question)),
    nextSteps: input.deterministic.nextSteps,
    answeredAt: new Date().toISOString(),
    qualityStatus: 'fallback',
    qualityReason: input.reason,
    answeredByPass: 'local',
    missingSections: input.missingSections,
  } satisfies PublicChatResponse
}

function buildResponseSections(input: {
  summary10s: string
  fullAnswer: string[]
  deliverables: string[]
  attentionPoints: string[]
  nextSteps: string[]
  followUpQuestions: string[]
}): PublicChatResponse['sections'] {
  const deliverables = cleanDeliverableItems(input.deliverables).slice(0, 3)
  const attentionPoints = cleanAttentionItems(input.attentionPoints).slice(0, 3)
  const nextSteps = cleanNextStepItems(input.nextSteps).slice(0, 3)
  const summary10s = buildSafeSummary(input.summary10s, deliverables, nextSteps)
  const fullAnswer = cleanFullAnswerItems(input.fullAnswer).slice(0, 4)
  return {
    summary10s,
    fullAnswer: fullAnswer.length > 0 ? fullAnswer : [summary10s],
    deliverables,
    attentionPoints,
    nextSteps,
    followUpQuestions: dedupeItems(input.followUpQuestions).slice(0, 3),
    answerMode:
      deliverables.length > 0 && nextSteps.length > 0
        ? 'grounded'
        : nextSteps.length > 0 || attentionPoints.length > 0
          ? 'mixed'
          : 'general_guidance',
  }
}

function extractSectionSummary(answer: string) {
  const parsed = parseStructuredAnswer(answer)
  return parsed.direct || sanitizeAnswerText(answer)
}

function buildDeterministicPackage(input: {
  topic: PublicTopic
  question: string
  citations: Citation[]
  intent: QuestionIntent
}): DeterministicPackage {
  const deliverables = buildDeliverableItems(input.topic, input.citations)
  const attention = buildAttentionItems(input.topic, input.citations).slice(0, 3)
  const nextSteps = buildActionableSteps({
    topic: input.topic,
    question: input.question,
    intent: input.intent,
    citations: input.citations,
  }).slice(0, 3)
  const direct = buildDirectFallback({
    topic: input.topic,
    question: input.question,
    intent: input.intent,
    citations: input.citations,
    deliverables,
  })

  return {
    answer: formatStructuredAnswer({
      direct,
      deliverables,
      attention,
      nextSteps,
    }),
    deliverables,
    attention,
    nextSteps,
  }
}

function buildDirectFallback(input: {
  topic: PublicTopic
  question: string
  intent: QuestionIntent
  citations: Citation[]
  deliverables: string[]
}) {
  const normalizedQuestion = normalizeText(input.question)
  const summaryBase = buildContextOverview(input.topic, input.citations)
  const attentionItems = buildAttentionItems(input.topic, input.citations)
  const cleanDeliverables = cleanDeliverableItems(input.deliverables)
  const toolContext = getToolUsageContext({
    topic: input.topic,
    citations: input.citations,
    question: input.question,
  })

  if (input.intent === 'smalltalk_or_noise') {
    return `Sua pergunta ficou vaga. Pergunte algo direto sobre ${input.topic.title}, como entregaveis, checklist ou pontos de atencao.`
  }

  if (input.intent === 'off_topic_learning') {
    return `Posso explicar o conceito de forma curta e depois conectar isso com ${input.topic.title}.`
  }

  if (input.intent === 'deliverable') {
    return cleanDeliverables.length > 0
      ? `Os entregaveis principais desta materia sao ${cleanDeliverables.join(', ')}.`
      : `Posso te ajudar melhor se voce perguntar pelo checklist ou abrir o anexo principal de ${input.topic.title}.`
  }

  if (input.intent === 'grading' || input.intent === 'format') {
    return attentionItems[0] || `Os pontos de atencao desta materia ficam mais claros quando voce olha o checklist e os criterios do anexo principal.`
  }

  if (input.intent === 'tool_usage') {
    if (/\bpython\b|\br\b|\bcodigo\b|\bscript\b|\bexcel\b|\bplanilha\b/.test(normalizedQuestion)) {
      if (toolContext.hasExplicitRequirement) {
        return `${toolContext.toolLabel} aparece no material como parte exigida ou claramente solicitada neste trabalho. Use essa ferramenta sem perder o foco no entregavel final.`
      }

      if (toolContext.hasMentionInContext) {
        return `${toolContext.toolLabel} aparece no contexto da disciplina, mas nao foi exigido explicitamente neste checkpoint. Se quiser usar, trate isso como apoio opcional para organizar, limpar ou analisar os dados antes de montar os entregaveis oficiais.`
      }

      return `${toolContext.toolLabel} nao foi exigido explicitamente no material de ${input.topic.title}. Se quiser usar, trate isso como apoio opcional para organizar, limpar ou analisar os dados antes de montar os entregaveis oficiais.`
    }
  }

  if (input.intent === 'next_steps' || input.intent === 'explanation' || input.intent === 'unknown') {
    if (/\bpython\b|\br\b|\bcodigo\b|\bscript\b/.test(normalizedQuestion)) {
      return input.citations.some((item) => /\bpython\b|\br\b|\bcodigo\b|\bscript\b/i.test(item.snippet))
        ? input.citations[0]?.snippet || 'Encontrei referencia pratica no material e vou te direcionar pelo que esta publicado.'
        : `Nao encontrei no material nenhuma etapa obrigatoria de programacao para ${input.topic.title}. O foco publicado parece estar mais nos entregaveis e nas validacoes finais.`
    }

    if (summaryBase) {
      return `Para avancar em ${input.topic.title}, comece pelo entregavel principal e siga um passo de cada vez.`
    }
  }

  if (input.intent === 'summary' || input.intent === 'greeting') {
    return summaryBase || `Posso resumir ${input.topic.title}, listar entregaveis ou montar um checklist curto.`
  }

  return input.citations[0]?.snippet
    || summaryBase
    || `Pergunte algo mais especifico sobre ${input.topic.title}, como entregaveis, formato ou checklist.`
}

function buildPrompt(input: {
  topic: PublicTopic
  question: string
  rankedChunks: PublishedKnowledgeChunk[]
  intent: QuestionIntent
}) {
  const normalizedLearning = normalizeLearning(input.topic.learning)
  const learningFaq = (normalizedLearning?.frequentQuestions ?? [])
    .slice(0, 4)
    .map((item) => `- ${item.question}: ${item.answer}`)
    .join('\n')
  const learningTopics = (normalizedLearning?.learningTopics ?? [])
    .slice(0, 3)
    .map((item) => `- ${item.title}: ${item.explanation} Dificuldade comum: ${item.commonDifficulty} Estrategia: ${item.studyStrategy}`)
    .join('\n')
  const quickTips = (normalizedLearning?.quickTips ?? [])
    .slice(0, 4)
    .map((item) => `- ${item}`)
    .join('\n')
  const deliverables = buildDeliverableItems(input.topic, input.rankedChunks.slice(0, 6).map((chunk) => ({
    sourceType: chunk.sourceType === 'overview' ? 'summary' : chunk.sourceType,
    sourceLabel: `${input.topic.title} / ${chunk.sourceType}`,
    snippet: chunk.text,
  })) satisfies Citation[])
  const attention = buildAttentionItems(input.topic, input.rankedChunks.slice(0, 6).map((chunk) => ({
    sourceType: chunk.sourceType === 'overview' ? 'summary' : chunk.sourceType,
    sourceLabel: `${input.topic.title} / ${chunk.sourceType}`,
    snippet: chunk.text,
  })) satisfies Citation[])
  const nextSteps = buildActionableSteps({
    topic: input.topic,
    question: input.question,
    intent: input.intent,
    citations: input.rankedChunks.slice(0, 6).map((chunk) => ({
      sourceType: chunk.sourceType === 'overview' ? 'summary' : chunk.sourceType,
      sourceLabel: `${input.topic.title} / ${chunk.sourceType}`,
      snippet: chunk.text,
    })) satisfies Citation[],
  })
  const chunkBlock = input.rankedChunks
    .map((chunk, index) => `[${index + 1}] ${chunk.sourceType}: ${cleanProviderSnippet(chunk.text)}`)
    .join('\n\n')
  const toolContext = getToolUsageContext({
    topic: input.topic,
    citations: input.rankedChunks.slice(0, 6).map((chunk) => ({
      sourceType: chunk.sourceType === 'overview' ? 'summary' : chunk.sourceType,
      sourceLabel: `${input.topic.title} / ${chunk.sourceType}`,
      snippet: chunk.text,
    })) satisfies Citation[],
    question: input.question,
  })

  return [
    'Voce e o assistente publico do FiapFlow.',
    'Responda em portugues do Brasil, de forma objetiva, natural e util para um aluno com pouco tempo.',
    'Sua resposta precisa ser clara, curta e visualmente limpa.',
    'Use apenas fatos confirmados do material e ignore ruido administrativo.',
    'Ignore prazo, data, horario, status, modulo, professor, nome bruto de arquivo, links e metadados administrativos.',
    'Nunca diga "nao encontrei isso no material", "nao sei" ou frases equivalentes.',
    'Se a pergunta for vaga ou ruido, nao invente resposta academica: peca uma reformulacao curta e ofereca 2 exemplos uteis.',
    'Se a pergunta sair da materia, explique em no maximo 2 frases e reconecte com a atividade atual.',
    'Nao repita a mesma ideia em mais de um bloco.',
    '',
    `Intencao principal da pergunta: ${input.intent}`,
    `Materia: ${input.topic.title}`,
    '',
    'Visao geral limpa:',
    buildContextOverview(input.topic, input.rankedChunks.slice(0, 6).map((chunk) => ({
      sourceType: chunk.sourceType === 'overview' ? 'summary' : chunk.sourceType,
      sourceLabel: `${input.topic.title} / ${chunk.sourceType}`,
      snippet: chunk.text,
    })) satisfies Citation[]) || 'Sem visao geral limpa.',
    '',
    'Entregaveis limpos:',
    deliverables.map((item) => `- ${item}`).join('\n') || '- Nenhum entregavel limpo identificado.',
    '',
    'Pontos de atencao limpos:',
    attention.map((item) => `- ${item}`).join('\n') || '- Nenhum ponto de atencao limpo identificado.',
    '',
    'Proximos passos seguros:',
    nextSteps.map((item) => `- ${item}`).join('\n') || '- Nenhum proximo passo limpo identificado.',
    '',
    'FAQ / aprendizado:',
    learningFaq || '- Nenhum FAQ publicado.',
    '',
    'Topicos de aprendizado:',
    learningTopics || '- Nenhum topico de aprendizado publicado.',
    '',
    'Dicas rapidas:',
    quickTips || '- Nenhuma dica rapida publicada.',
    '',
    'Trechos relevantes do material:',
    chunkBlock || 'Nenhum trecho relevante encontrado.',
    '',
    `Pergunta do usuario: ${input.question}`,
    '',
    'Formato obrigatorio da resposta:',
    'RESPOSTA DIRETA:',
    'O QUE ENTREGAR:',
    'ATENCAO:',
    'PROXIMO PASSO:',
    '',
    'Regras do formato:',
    '- RESPOSTA DIRETA: 1 ou 2 frases curtas respondendo exatamente a pergunta.',
    '- O QUE ENTREGAR: 0 a 3 bullets limpos, apenas itens humanos e curtos.',
    '- ATENCAO: 0 a 3 bullets curtos, um risco por linha, sem repetir prazo.',
    '- PROXIMO PASSO: 1 a 3 bullets acionaveis, em ordem pratica.',
    '- Se um bloco nao tiver valor real, deixe o bloco vazio depois dos dois pontos.',
    '- Nao use markdown, tabela, pipe, titulo com #, bloco de codigo ou texto decorativo.',
    '- Nao copie links, nomes de arquivo crus ou cabecalhos administrativos.',
    '- Cada bullet deve caber bem em uma interface compacta.',
    ...(input.intent === 'tool_usage'
      ? [
          '- Esta e uma pergunta de ferramenta/execucao.',
          `- Primeiro diga claramente se ${toolContext.toolLabel} e obrigatorio, opcional, ou se nao foi exigido explicitamente no material.`,
          `- Se ${toolContext.toolLabel} aparecer apenas no contexto da disciplina, deixe claro que isso nao significa exigencia deste checkpoint.`,
          `- Se ${toolContext.toolLabel} nao aparecer no material, nao transforme isso em exigencia.`,
          `- Explique em 1 ou 2 frases como ${toolContext.toolLabel} pode ajudar opcionalmente dentro deste trabalho sem fugir da entrega real.`,
          '- O PROXIMO PASSO deve dizer o caminho mais seguro para cumprir a atividade mesmo sem depender da ferramenta.',
        ]
      : []),
  ].join('\n')
}

function buildRetryPrompt(input: {
  topic: PublicTopic
  question: string
  intent: QuestionIntent
  previousAnswer: string
  qualityReason: string
  missingSections: string[]
  rankedChunks: PublishedKnowledgeChunk[]
}) {
  return [
    buildPrompt(input),
    '',
    'Sua resposta anterior ficou insuficiente.',
    `Motivo da rejeicao: ${input.qualityReason}`,
    `Blocos faltando ou fracos: ${input.missingSections.length > 0 ? input.missingSections.join(', ') : 'resposta direta'}`,
    '',
    'Agora corrija com estas exigencias extras:',
    '- Primeiro responda a duvida principal sem enrolar.',
    '- Remova links, prazo, horario, professor, curso, modulo, status e nome bruto de arquivo.',
    '- Se a pergunta pedir dica, caminho, ajuda pratica ou "nao entendi", transforme isso em orientacao de execucao.',
    '- Se a pergunta for vaga, peca reformulacao curta e ofereca dois exemplos uteis.',
    '- Nao diga para consultar documentacao generica.',
    '- Nao devolva apenas titulo, frase motivacional, resumo vago ou texto copiado do PDF.',
    '- Mantenha os mesmos blocos obrigatorios.',
    ...(input.intent === 'tool_usage'
      ? [
          '- Para pergunta sobre ferramenta, a RESPOSTA DIRETA precisa deixar claro se isso e obrigatorio ou apenas opcional.',
          '- Se a ferramenta nao estiver no material, diga isso logo na primeira frase.',
          '- Em seguida, diga como ela poderia ajudar opcionalmente sem mudar os entregaveis oficiais.',
          '- O PROXIMO PASSO deve ancorar o aluno na entrega real, nao na ferramenta.',
        ]
      : []),
    '',
    'Resposta anterior ruim:',
    input.previousAnswer,
  ].join('\n')
}

function buildDocuments(topic: PublicTopic, citations: Citation[]) {
  const normalizedLearning = normalizeLearning(topic.learning)
  const deliverables = buildDeliverableItems(topic, citations)
  const attention = buildAttentionItems(topic, citations)

  return [
    {
      name: `${topic.id}.summary.txt`,
      content: buildContextOverview(topic, citations),
    },
    {
      name: `${topic.id}.memory.txt`,
      content: JSON.stringify({
        overview: buildContextOverview(topic, citations),
        deliverables,
        attention,
        keyFacts: cleanAttentionItems(topic.agentMemory?.keyFacts ?? []).slice(0, 5),
      }),
    },
    {
      name: `${topic.id}.learning.txt`,
      content: JSON.stringify({
        frequentQuestions: normalizedLearning?.frequentQuestions ?? [],
        learningTopics: normalizedLearning?.learningTopics ?? [],
        quickTips: normalizedLearning?.quickTips ?? [],
      }),
    },
    {
      name: `${topic.id}.citations.txt`,
      content: citations.map((item) => `${item.sourceType}: ${cleanProviderSnippet(item.snippet)}`).join('\n'),
    },
  ].filter((item) => item.content.trim())
}

async function readTopicImages(topic: PublicTopic) {
  const imageKeys = topic.screenshots.slice(0, 2)
  const images = await Promise.all(
    imageKeys.map(async (key, index) => {
      try {
        const resolved = path.resolve(runtimePaths.publicCurrentDir, ...key.replace(/^\/+/, '').split('/'))
        const root = path.resolve(runtimePaths.publicCurrentDir)
        if (!resolved.startsWith(root)) {
          return null
        }

        const buffer = await fs.readFile(resolved)
        return {
          name: `${topic.id}-image-${index + 1}.png`,
          mime: 'image/png',
          data: buffer.toString('base64'),
        }
      } catch {
        return null
      }
    }),
  )

  return images.filter((item): item is NonNullable<typeof item> => Boolean(item))
}

function buildDeliverableItems(topic: PublicTopic, citations: Citation[]) {
  const summaryItems = extractDeliverableSignals(topic.summary || '')
  const memoryItems = (topic.agentMemory?.deliverables ?? []).flatMap((item) => extractDeliverableSignals(item))
  const attachmentItems = topic.attachments.map((item) => normalizeDeliverableSignal(item.name))
  const citationItems = citations
    .filter((item) => item.sourceType === 'deliverable' || /pdf|excel|xlsx|apresenta|formulario|planilha|oral|pesquisa|questionario/i.test(item.snippet))
    .flatMap((item) => extractDeliverableSignals(item.snippet))

  const values = cleanDeliverableItems([
    ...memoryItems,
    ...summaryItems,
    ...citationItems,
    ...attachmentItems,
  ])

  if (values.length > 0) {
    return values.slice(0, 3)
  }

  return []
}

function buildActionableSteps(input: {
  topic: PublicTopic
  question: string
  intent: QuestionIntent
  citations: Citation[]
}) {
  const steps: string[] = []
  const normalizedQuestion = normalizeText(input.question)
  const toolContext = getToolUsageContext({
    topic: input.topic,
    citations: input.citations,
    question: input.question,
  })

  if (/\bpython\b|\br\b|\bcodigo\b|\bscript\b/.test(normalizedQuestion)) {
    if (!toolContext.hasExplicitRequirement) {
      steps.push(`Nao trate ${toolContext.toolLabel} como exigencia agora: primeiro confirme o que realmente foi pedido no trabalho.`)
      steps.push('Se este checkpoint for o correto, foque nos entregaveis publicados e valide o PDF principal.')
    }
  }

  if (input.intent === 'smalltalk_or_noise') {
    return [
      'Pergunte algo direto, como "o que preciso entregar?" ou "me faca um checklist".',
      `Se quiser, eu posso resumir ${input.topic.title} em linguagem simples.`,
    ]
  }

  if (input.intent === 'off_topic_learning') {
    steps.push('Aprenda o conceito em duas ou tres ideias simples e depois aplique isso ao entregavel atual.')
  }

  if (input.intent === 'deliverable') {
    steps.push('Monte uma checklist curta dos arquivos que precisam ser enviados antes de produzir a versao final.')
  }

  if (input.intent === 'tool_usage') {
    if (/\bpython\b|\br\b|\bcodigo\b|\bscript\b/.test(normalizedQuestion)) {
      steps.push(`Se quiser usar ${toolContext.toolLabel}, use apenas para apoiar a organizacao, limpeza ou analise dos dados antes de montar o arquivo final.`)
      steps.push('Nao comece codando no escuro: confirme primeiro o entregavel oficial e depois exporte o resultado final no formato pedido.')
    }
  }

  if (input.intent === 'next_steps' || input.intent === 'explanation' || input.intent === 'unknown') {
    steps.push(`Transforme ${input.topic.title} em 2 ou 3 tarefas praticas antes de executar.`)
  }

  steps.push('Abra o anexo principal para validar detalhes finos antes de executar.')

  const deliverables = buildDeliverableItems(input.topic, input.citations)
  if (deliverables.length > 0) {
    steps.push(`Prepare primeiro os entregaveis principais: ${deliverables.slice(0, 2).join(' e ')}.`)
  } else {
    steps.push('Monte uma checklist curta com entregaveis, formato e validacoes finais.')
  }

  return cleanNextStepItems(steps).slice(0, 3)
}

function buildAttentionItems(topic: PublicTopic, citations: Citation[]) {
  const sourceText = normalizeText([
    ...(topic.agentMemory?.keyFacts ?? []),
    ...citations.map((item) => item.snippet),
    topic.summary,
  ].filter(Boolean).join(' '))
  const items: string[] = []

  if (/\b100\b.*respondent|dados fictic/.test(sourceText)) {
    items.push('Use respondentes reais e nao inclua dados ficticios.')
  }
  if (/ausencia.*oral|nota zero|particip/.test(sourceText)) {
    items.push('Garanta a participacao oral de quem for avaliado.')
  }
  if (/abnt|sem links|formatos? sem links/.test(sourceText)) {
    items.push('Siga ABNT e nao deixe links nos arquivos finais.')
  }
  if (/nome completo|matricul/.test(sourceText)) {
    items.push('Inclua nome completo e matricula em cada arquivo.')
  }
  if (/maximo 6 por grupo/.test(sourceText)) {
    items.push('Mantenha o grupo dentro do limite de integrantes.')
  }

  if (items.length > 0) {
    return cleanAttentionItems(items).slice(0, 3)
  }

  return cleanAttentionItems(['Confirme no PDF principal os criterios finais antes de enviar.']).slice(0, 1)
}

function evaluateAnswerQuality(input: {
  question: string
  topic: PublicTopic
  intent: QuestionIntent
  parsed: ParsedStructuredAnswer
  citations: Citation[]
}): QualityEvaluation {
  const missingSections: string[] = []
  const combinedDirect = normalizeText(input.parsed.direct)
  const combinedAll = normalizeText(
    [input.parsed.direct, ...input.parsed.deliverables, ...input.parsed.attention, ...input.parsed.nextSteps].join(' '),
  )
  const hasRelevantContext = Boolean(input.topic.summary || input.topic.agentMemory?.overview || input.citations.length > 0)
  const directLooksGeneric =
    !input.parsed.direct
    || combinedDirect.length < 24
    || /^oi\b|^ola\b|^teste\b/.test(combinedDirect)
    || /^posso te ajudar/.test(combinedDirect)
    || /^nao encontrei isso no material$/.test(combinedDirect)
    || /^nao encontrei no material/.test(combinedDirect) && hasRelevantContext && input.parsed.nextSteps.length === 0
    || looksLikeRawMetadata(input.parsed.direct)

  if (directLooksGeneric) {
    missingSections.push('RESPOSTA DIRETA')
  }

  switch (input.intent) {
    case 'deliverable':
      if (cleanDeliverableItems(input.parsed.deliverables).length === 0 && !/entrega|arquivo|pdf|excel|anexo/.test(combinedAll)) {
        missingSections.push('O QUE ENTREGAR')
      }
      break
    case 'grading':
    case 'format':
      if (cleanAttentionItems(input.parsed.attention).length === 0 && !/penalidade|erro|abnt|nota|formato|risco|zero/.test(combinedAll)) {
        missingSections.push('ATENCAO')
      }
      break
    case 'tool_usage':
    case 'next_steps':
    case 'explanation':
    case 'unknown':
    case 'off_topic_learning':
      if (!hasActionableStep(input.parsed.nextSteps) && !/\bfa(ca|ca|zer)|abra|prepare|confirme|ignore|foco|siga|valide|use\b/.test(combinedAll)) {
        missingSections.push('PROXIMO PASSO')
      }
      break
    case 'smalltalk_or_noise':
      if (!/\b(pergunte|reformule|exemplo|entregaveis|checklist|pontos de atencao)\b/.test(combinedAll)) {
        missingSections.push('RESPOSTA DIRETA')
      }
      break
    case 'summary':
      if (combinedDirect.length < 60) {
        missingSections.push('RESPOSTA DIRETA')
      }
      break
    case 'greeting':
      if (combinedDirect.length < 40 && input.parsed.nextSteps.length === 0) {
        missingSections.push('RESPOSTA DIRETA')
      }
      break
    default:
      break
  }

  if ([...input.parsed.deliverables, ...input.parsed.attention, ...input.parsed.nextSteps].some(looksLikeBadPublicOutput)) {
    if (!missingSections.includes('O QUE ENTREGAR')) {
      missingSections.push('O QUE ENTREGAR')
    }
    if (!missingSections.includes('ATENCAO')) {
      missingSections.push('ATENCAO')
    }
  }

  if (/\bpython\b|\bcodigo\b|\bscript\b/.test(normalizeText(input.question))) {
    const toolContext = getToolUsageContext({
      topic: input.topic,
      citations: input.citations,
      question: input.question,
    })
    const toolMentionPattern = new RegExp(`\\b${toolContext.toolKey}\\b`, 'i')
    const mentionsQuestion = toolMentionPattern.test(combinedDirect)
    const redirectsAction = hasActionableStep(input.parsed.nextSteps)
    const marksOptionality = new RegExp(`\\b(opcional|obrigatori|nao foi exigid|nao e obrigatori|nao aparece como exigenc|nao encontrei .*${toolContext.toolKey}|${toolContext.toolKey} .*opcional|${toolContext.toolKey} .*nao foi exigid)\\b`, 'i').test(combinedDirect)
    const explainsPracticalUsage = /\b(organizar|limpar|analisar|consolidar|apoiar|resumir|tratar|usar .* para)\b/.test(combinedAll)
    const anchorsDeliverable = /\b(entrega|entregavel|pdf|excel|planilha|arquivo|teams|apresenta)\b/.test(combinedAll)
    const inventsMandatoryUsage = !toolContext.hasExplicitRequirement && /\b(use|instale|roda|rode|aplique)\s+python\b/.test(combinedDirect) && !marksOptionality

    if (!mentionsQuestion || !redirectsAction || !marksOptionality || !explainsPracticalUsage || !anchorsDeliverable || inventsMandatoryUsage) {
      if (!missingSections.includes('RESPOSTA DIRETA')) {
        missingSections.push('RESPOSTA DIRETA')
      }
      if (!missingSections.includes('PROXIMO PASSO')) {
        missingSections.push('PROXIMO PASSO')
      }
    }
  }

  return {
    accepted: missingSections.length === 0,
    reason:
      missingSections.length === 0
        ? 'Resposta validada pela IA.'
        : `Resposta insuficiente para a intencao ${input.intent}; faltou autosuficiencia em ${missingSections.join(', ')}.`,
    missingSections,
  }
}

function parseStructuredAnswer(answer: string | undefined): ParsedStructuredAnswer {
  const lines = (answer ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)

  const parsed: ParsedStructuredAnswer = {
    direct: '',
    deliverables: [],
    attention: [],
    nextSteps: [],
    extra: [],
  }

  let currentSection: keyof ParsedStructuredAnswer | null = null

  for (const line of lines) {
    const sectionMatch = line.match(/^([A-Za-z\s]+):\s*(.*)$/)
    if (sectionMatch) {
      const sectionKey = normalizeSectionKey(sectionMatch[1] ?? '')
      if (sectionKey) {
        currentSection = sectionKey
        const inlineValue = sectionMatch[2]?.trim()
        if (inlineValue) {
          pushStructuredValue(parsed, sectionKey, inlineValue)
        }
        continue
      }
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)$/)
    if (bulletMatch && currentSection) {
      pushStructuredValue(parsed, currentSection, bulletMatch[1] ?? '')
      continue
    }

    if (currentSection) {
      pushStructuredValue(parsed, currentSection, line)
      continue
    }

    const cleaned = sanitizeAnswerText(line)
    if (cleaned) {
      parsed.extra.push(cleaned)
    }
  }

  if (!parsed.direct) {
    parsed.direct = parsed.extra[0] || sanitizeAnswerText(answer ?? '')
  }

  return parsed
}

function normalizeSectionKey(value: string): keyof ParsedStructuredAnswer | null {
  const normalized = normalizeText(value)

  if (/^resposta direta|^resumo em 10 segundos|^resumo rapido/.test(normalized)) return 'direct'
  if (/^o que entregar|^entrega|^entregaveis?/.test(normalized)) return 'deliverables'
  if (/^atencao|^ponto de atencao|^riscos?/.test(normalized)) return 'attention'
  if (/^proximo passo|^proximos passos|^checklist|^como fazer|^como comecar|^comece assim/.test(normalized)) return 'nextSteps'

  return null
}

function pushStructuredValue(parsed: ParsedStructuredAnswer, key: keyof ParsedStructuredAnswer, value: string) {
  const cleaned = sanitizeAnswerText(value)
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

function formatStructuredAnswer(input: {
  direct: string
  deliverables: string[]
  attention: string[]
  nextSteps: string[]
}) {
  const lines = [`RESPOSTA DIRETA: ${sanitizeAnswerText(input.direct) || 'Pergunte de forma mais especifica sobre esta materia.'}`]
  const deliverables = formatSectionItems(cleanDeliverableItems(input.deliverables))
  const attention = formatSectionItems(cleanAttentionItems(input.attention))
  const nextSteps = formatSectionItems(cleanNextStepItems(input.nextSteps))
  if (deliverables) {
    lines.push(`O QUE ENTREGAR: ${deliverables}`)
  }
  if (attention) {
    lines.push(`ATENCAO: ${attention}`)
  }
  if (nextSteps) {
    lines.push(`PROXIMO PASSO: ${nextSteps}`)
  }

  return lines.join('\n')
}

function formatSectionItems(items: string[]) {
  const visibleItems = dedupeItems(items.map((item) => sanitizeAnswerText(item))).filter(Boolean)
  if (visibleItems.length === 0) {
    return ''
  }

  return visibleItems.slice(0, 3).map((item) => `- ${item}`).join(' ')
}

function buildSuggestedQuestions(intent: QuestionIntent) {
  if (intent === 'deliverable') {
    return ['Me faca um checklist', 'O que pode me fazer perder pontos?', 'Como eu organizo essa entrega?']
  }

  if (intent === 'tool_usage') {
    return ['Isso e obrigatorio ou opcional?', 'Me faca um checklist sem usar codigo', 'Como faco isso sem me perder?']
  }

  if (intent === 'smalltalk_or_noise') {
    return ['O que preciso entregar?', 'Me faca um checklist', 'O que pode me fazer perder pontos?']
  }

  if (intent === 'off_topic_learning') {
    return ['Explique este trabalho de forma simples', 'Como aplico isso nesta atividade?', 'Me faca um checklist']
  }

  if (intent === 'next_steps' || intent === 'explanation' || intent === 'unknown') {
    return ['Me faca um checklist', 'Explique este trabalho de forma simples', 'O que preciso entregar?']
  }

  return ['O que preciso entregar?', 'Me faca um checklist', 'O que pode me fazer perder pontos?']
}

function rankChunks(chunks: PublishedKnowledgeChunk[], question: string, intent: QuestionIntent) {
  const tokens = tokenize(question)
  const ranked = chunks
    .map((chunk) => ({
      chunk,
      score: tokens.reduce((total, token) => {
        let nextTotal = total
        if (normalizeText(chunk.text).includes(token)) nextTotal += 1
        if (chunk.keywords.map((item) => normalizeText(item)).includes(token)) nextTotal += 2
        return nextTotal
      }, 0) + sourceTypeIntentBoost(chunk.sourceType, intent, question),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.chunk)

  if (ranked.length > 0) {
    return ranked
  }

  return chunks
    .map((chunk) => ({
      chunk,
      score: fallbackChunkScore(chunk, intent),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.chunk)
}

function tokenize(value: string) {
  return normalizeText(value)
    .split(/[^a-z0-9]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3 || /^\d+$/.test(item))
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function sanitizeAnswerText(value: string) {
  return value
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^>\s*/g, '')
    .replace(/^#{1,6}\s*/g, '')
    .replace(/\s*\|\s*/g, ' - ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasActionableStep(values: string[]) {
  return values.some((value) => /\b(abra|prepare|valide|monte|revise|confirme|ignore|foco|siga|use|envie|verifique)\b/i.test(value))
}

function dedupeItems(values: Array<string | undefined>) {
  const seen = new Set<string>()
  const items: string[] = []

  for (const value of values) {
    const cleaned = sanitizeAnswerText(value ?? '')
    if (!cleaned) {
      continue
    }

    const key = normalizeText(cleaned)
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    items.push(cleaned)
  }

  return items
}

function extractDeliverableSignals(text: string) {
  const normalized = sanitizeAnswerText(text)
  const matches = [
    /apresenta(?:cao|ção).*?pdf/gi,
    /formulario.*?pdf/gi,
    /questionario.*?pdf/gi,
    /pesquisa.*?pdf/gi,
    /base de dados.*?(?:excel|xlsx)/gi,
    /planilha.*?(?:excel|xlsx)/gi,
    /arquivo\s+"[^"]+"/gi,
  ]

  const results: string[] = []
  for (const pattern of matches) {
    const found = normalized.match(pattern) ?? []
    results.push(...found.map((item) => normalizeDeliverableSignal(item)))
  }

  return cleanDeliverableItems(results)
}

function extractToolLabel(question: string) {
  const normalized = normalizeText(question)
  if (/\bpython\b/.test(normalized)) return 'Python'
  if (/\br\b/.test(normalized)) return 'R'
  if (/\bexcel\b|\bplanilha\b/.test(normalized)) return 'Excel'
  if (/\bcodigo\b|\bscript\b/.test(normalized)) return 'codigo'
  return 'essa ferramenta'
}

function getToolUsageContext(input: {
  topic: PublicTopic
  citations: Citation[]
  question: string
}): ToolUsageContext {
  const toolLabel = extractToolLabel(input.question)
  const toolKey = normalizeText(toolLabel)
  const contextualText = normalizeText([
    input.topic.summary,
    input.topic.agentMemory?.overview,
    ...(input.topic.agentMemory?.keyFacts ?? []),
    ...((normalizeLearning(input.topic.learning)?.learningTopics ?? []).flatMap((item) => [item.title, item.explanation, item.commonDifficulty, item.studyStrategy])),
    ...((normalizeLearning(input.topic.learning)?.frequentQuestions ?? []).flatMap((item) => [item.question, item.answer])),
    ...input.citations.map((item) => item.snippet),
  ].filter(Boolean).join(' '))
  const requirementText = normalizeText([
    ...(input.topic.agentMemory?.deliverables ?? []),
    ...input.citations.map((item) => item.snippet),
  ].filter(Boolean).join(' '))
  const mentionPattern = toolKey !== 'essa ferramenta' ? new RegExp(`\\b${toolKey}\\b`, 'i') : null
  const requirementPattern = toolKey !== 'essa ferramenta'
    ? new RegExp(`\\b${toolKey}\\b.{0,80}\\b(obrigatori|deve|precisa|use|utilize|script|codigo|program|xlsx|excel|planilha|envie|entreg)`, 'i')
    : null

  return {
    toolLabel,
    toolKey,
    hasMentionInContext: Boolean(mentionPattern?.test(contextualText)),
    hasExplicitRequirement: Boolean(requirementPattern?.test(requirementText)),
  }
}

function normalizeLearning(learning: PublicTopic['learning']) {
  if (!learning) {
    return null
  }

  const legacyTopics = (learning.simpleConcepts ?? [])
    .map((item) => ({
      title: item.title,
      explanation: item.content,
      commonDifficulty: 'Uma dificuldade comum e transformar esse texto em execucao pratica.',
      studyStrategy: 'Use esse ponto como guia e conecte a explicacao com o enunciado antes de agir.',
    }))

  return {
    frequentQuestions: learning.frequentQuestions ?? [],
    learningTopics: learning.learningTopics ?? legacyTopics,
    quickTips: learning.quickTips ?? [],
  }
}

function shouldAttachTopicImages(question: string) {
  return /\b(print|imagem|screenshot|tela|diagrama|grafico)\b/i.test(question)
}

function buildSafeSummary(summary: string, deliverables: string[], nextSteps: string[]) {
  const cleaned = sanitizeAnswerText(summary)
  if (cleaned && !looksLikeBadPublicOutput(cleaned)) {
    return cleaned
  }
  if (deliverables[0]) {
    return `Os entregaveis principais sao ${deliverables.slice(0, 2).join(' e ')}.`
  }
  if (nextSteps[0]) {
    return nextSteps[0]
  }
  return 'Pergunte de forma mais especifica sobre esta materia.'
}

function buildContextOverview(topic: PublicTopic, citations: Citation[]) {
  const candidates = [
    topic.summary,
    topic.agentMemory?.overview,
    ...citations.map((item) => item.snippet),
  ]
    .map((item) => cleanProviderSnippet(item ?? ''))
    .filter(Boolean)

  return dedupeItems(candidates).find((item) => !looksLikeRawMetadata(item)) ?? ''
}

function cleanProviderSnippet(value: string) {
  return sanitizeAnswerText(value)
    .replace(/\b(pergunta|resposta):\s*/gi, '')
    .replace(/\b(prazo|data|horario)\b.*$/gi, '')
    .replace(/\b(link de detalhe|status|curso|modulo sugerido|arquivos baixados)\b.*$/gi, '')
    .replace(/https?:\/\/\S+/gi, '')
    .trim()
}

function cleanDeliverableItems(values: string[]) {
  return dedupeItems(values.map((item) => normalizeDeliverableSignal(item)).filter(isUsefulDeliverableSignal))
}

function cleanAttentionItems(values: string[]) {
  return dedupeItems(
    values
      .flatMap((item) => sanitizeAnswerText(item).split(/\s*;\s*|\.\s+(?=[A-Z0-9])/))
      .map((item) => sanitizeAnswerText(item))
      .map((item) => item.replace(/^pontos?\s+de\s+atencao:\s*/i, ''))
      .map((item) => item.replace(/\b(atraso superior a 15 minutos|07:45|08:00|23:59)\b.*$/i, ''))
      .map((item) => item.replace(/\b(link de detalhe|teams\.microsoft)\b.*$/i, ''))
      .filter((item) => item.length > 10 && item.length <= 120)
      .filter((item) => !looksLikeRawMetadata(item))
      .filter((item) => !/\b(prazo|horario|data)\b/i.test(item)),
  )
}

function cleanNextStepItems(values: string[]) {
  return dedupeItems(
    values
      .flatMap((item) => sanitizeAnswerText(item).split(/\s*;\s*|\.\s+(?=[A-Z0-9])/))
      .map((item) => sanitizeAnswerText(item.replace(/^\d+\.\s*/, '')))
      .map((item) => item.replace(/\b(link de detalhe|teams\.microsoft)\b.*$/i, ''))
      .filter((item) => item.length > 12 && item.length <= 120)
      .filter((item) => !looksLikeRawMetadata(item)),
  )
}

function cleanFullAnswerItems(values: string[]) {
  return dedupeItems(
    values
      .flatMap((item) => sanitizeAnswerText(item).split(/\n+|\s*;\s*/))
      .map((item) => sanitizeAnswerText(item))
      .filter((item) => item.length > 16 && item.length <= 180)
      .filter((item) => !looksLikeBadPublicOutput(item)),
  )
}

function normalizeDeliverableSignal(value: string) {
  const cleaned = sanitizeAnswerText(value)
    .replace(/^arquivo:\s*/i, '')
    .replace(/\.pdf$/i, ' PDF')
    .replace(/\.docx$/i, '')
    .replace(/\.xlsx$/i, ' Excel')
    .replace(/[_-]+/g, ' ')
    .trim()

  if (/(apresenta|slide)/i.test(cleaned) && /pdf/i.test(cleaned)) return 'Apresentacao em PDF'
  if (/(formular|questionario|pesquisa)/i.test(cleaned) && /pdf/i.test(cleaned)) return 'Formulario ou pesquisa em PDF'
  if (/(base de dados|planilha|excel|xlsx)/i.test(cleaned)) return 'Base de dados em Excel'
  if (/(apresentacao oral|oral individual|apresenta[cç][aã]o oral)/i.test(cleaned)) return 'Apresentacao oral individual'
  if (/respondentes reais|pesquisa em grupo/i.test(cleaned)) return 'Pesquisa com respondentes reais'
  return cleaned
}

function isUsefulDeliverableSignal(value: string) {
  const cleaned = sanitizeAnswerText(value)
  return Boolean(cleaned)
    && cleaned.length >= 4
    && cleaned.length <= 60
    && !looksLikeRawMetadata(cleaned)
    && !/\b(prazo|horario|data|status|curso|modulo|professor|teams\.microsoft|checkpoint.*docx|\.py)\b/i.test(cleaned)
}

function looksLikeBadPublicOutput(value: string) {
  const normalized = sanitizeAnswerText(value)
  return !normalized
    || looksLikeRawMetadata(normalized)
    || /\bnao encontrei isso no material\b/i.test(normalized)
    || /\bnao sei\b/i.test(normalized)
    || /\b(prazo|07:45|08:00|23:59|atraso superior a 15 minutos)\b/i.test(normalized)
}

function sourceTypeIntentBoost(sourceType: PublishedKnowledgeChunk['sourceType'], intent: QuestionIntent, question: string) {
  if (intent === 'deliverable' && sourceType === 'deliverable') return 3
  if ((intent === 'grading' || intent === 'format') && sourceType === 'faq') return 2
  if ((intent === 'summary' || intent === 'explanation') && sourceType === 'summary') return 2
  if (intent === 'tool_usage' && /\bpython\b|\br\b|\bcodigo\b|\bscript\b/i.test(question) && sourceType === 'content') return 2
  if (intent === 'smalltalk_or_noise' && sourceType === 'summary') return 1
  return 0
}

function fallbackChunkScore(chunk: PublishedKnowledgeChunk, intent: QuestionIntent) {
  if (intent === 'deliverable' && chunk.sourceType === 'deliverable') return 4
  if ((intent === 'summary' || intent === 'explanation') && (chunk.sourceType === 'summary' || chunk.sourceType === 'overview')) return 3
  if (intent === 'tool_usage' && chunk.sourceType === 'content') return 2
  if (chunk.sourceType === 'faq') return 1
  return 0
}

function looksLikeRawMetadata(value: string) {
  return /(teams\.microsoft|status:|curso:|modulo sugerido|professor|tecnologo|disciplina:|checkpoint.*docx|arquivo\s+"|arquivos baixados|link de detalhe)/i.test(value)
}

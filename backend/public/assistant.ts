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
  const rankedChunks = rankChunks(scopedChunks, input.question)
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
  const images = await readTopicImages(input.topic)

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
    return {
      topicId: input.input.topic.id,
      answer: input.answer,
      confidence: input.confidence,
      strategyUsed: input.providerResponse.strategyUsed,
      providerUsed: input.providerResponse.providerUsed,
      fallbackLevel: input.providerResponse.fallbackLevel,
      citations: input.citations,
      suggestedQuestions: buildSuggestedQuestions(input.intent),
      nextSteps: buildActionableSteps({
        topic: input.input.topic,
        question: input.input.question,
        intent: input.intent,
        citations: input.citations,
      }),
      answeredAt: new Date().toISOString(),
      qualityStatus: 'fallback',
      qualityReason: evaluation.reason,
      answeredByPass: input.answeredByPass,
      missingSections: evaluation.missingSections,
    } satisfies PublicChatResponse
  }

  return {
    topicId: input.input.topic.id,
    answer: formatStructuredAnswer({
      direct: parsed.direct,
      deliverables: parsed.deliverables,
      attention: parsed.attention,
      nextSteps: parsed.nextSteps,
    }),
    confidence: input.confidence,
    strategyUsed: input.providerResponse.strategyUsed,
    providerUsed: input.providerResponse.providerUsed,
    fallbackLevel: input.providerResponse.fallbackLevel,
    citations: input.citations,
    suggestedQuestions: buildSuggestedQuestions(input.intent),
    nextSteps: parsed.nextSteps.length > 0
      ? parsed.nextSteps.slice(0, 3)
      : buildActionableSteps({
        topic: input.input.topic,
        question: input.input.question,
        intent: input.intent,
        citations: input.citations,
      }),
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
  const summaryBase = input.topic.summary || input.topic.agentMemory?.overview || input.citations[0]?.snippet || ''
  const toolContext = getToolUsageContext({
    topic: input.topic,
    citations: input.citations,
    question: input.question,
  })

  if (input.intent === 'deliverable') {
    return input.deliverables.length > 0
      ? `Voce precisa focar nestes entregaveis principais: ${input.deliverables.join(', ')}.`
      : 'Nao encontrei uma lista fechada de entregaveis no material publicado.'
  }

  if (input.intent === 'grading' || input.intent === 'format') {
    const risk = buildAttentionItems(input.topic, input.citations)[0]
    return risk || 'Nao encontrei um criterio detalhado, mas ha pontos de atencao importantes no material.'
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
      return `Para fazer ${input.topic.title} sem se enrolar, foque primeiro no objetivo central e siga uma sequencia curta de execucao.`
    }
  }

  if (input.intent === 'summary' || input.intent === 'greeting') {
    return summaryBase || `Vou te ajudar com ${input.topic.title} pelo ponto mais util do material publicado.`
  }

  return input.citations[0]?.snippet
    || summaryBase
    || `Vou te responder pelo que esta publicado em ${input.topic.title}.`
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
  const keyFacts = (input.topic.agentMemory?.keyFacts ?? [])
    .slice(0, 8)
    .map((item) => `- ${item}`)
    .join('\n')
  const chunkBlock = input.rankedChunks
    .map((chunk, index) => `[${index + 1}] ${chunk.sourceType}: ${chunk.text}`)
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
    'Voce e o assistente publico do FIAPAUTO.',
    'Responda em portugues do Brasil, de forma objetiva, natural e util para um aluno cansado e com pressa.',
    'A resposta precisa ser autosuficiente: curta, clara e util sem depender de texto extra.',
    'Use apenas o material fornecido. Se algo nao estiver confirmado, diga explicitamente que nao encontrou.',
    'Se a pergunta for vaga, pratica ou de ajuda ("como fazer", "nao entendi", "me da uma dica"), transforme isso em orientacao executavel com base no trabalho real.',
    'Nunca responda so com uma frase vaga, so com uma saudacao, ou so com "nao encontrei".',
    '',
    `Intencao principal da pergunta: ${input.intent}`,
    `Materia: ${input.topic.title}`,
    `Curso: ${input.topic.course}`,
    `Modulo: ${input.topic.moduleKey}`,
    `Status: ${input.topic.status}`,
    '',
    'Resumo publicado:',
    input.topic.summary || 'Nao existe resumo publicado.',
    '',
    'Memoria do agente:',
    input.topic.agentMemory?.overview || 'Nao existe memoria publicada.',
    '',
    'Entregaveis conhecidos:',
    (input.topic.agentMemory?.deliverables ?? []).map((item) => `- ${item}`).join('\n') || '- Nenhum entregavel confirmado.',
    '',
    'Fatos importantes:',
    keyFacts || '- Nenhum fato importante publicado.',
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
    '- Seja curto, concreto e sem floreio.',
    '- Preencha todos os blocos com algo util.',
    '- Se um bloco nao tiver informacao confirmada, diga exatamente "Nao encontrei isso no material".',
    '- Para pergunta pratica, o bloco PROXIMO PASSO deve trazer acao executavel.',
    '- Nao use markdown, tabela, pipe, asterisco, titulos com # ou texto decorativo.',
    '- Nao invente dados, regras ou entregaveis.',
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
    '- Se a pergunta pedir dica, caminho, ajuda pratica ou "nao entendi", transforme isso em orientacao de execucao.',
    '- Se o material nao falar exatamente do termo perguntado, explique isso e redirecione para o que o trabalho realmente exige.',
    '- Nao diga para consultar documentacao generica.',
    '- Nao devolva apenas titulo, frase motivacional ou resumo vago.',
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

  return [
    {
      name: `${topic.id}.summary.txt`,
      content: topic.summary || '',
    },
    {
      name: `${topic.id}.memory.txt`,
      content: JSON.stringify({
        overview: topic.agentMemory?.overview ?? '',
        deliverables: topic.agentMemory?.deliverables ?? [],
        keyFacts: topic.agentMemory?.keyFacts ?? [],
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
      content: citations.map((item) => `${item.sourceType}: ${item.snippet}`).join('\n'),
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
  const citationItems = citations
    .filter((item) => item.sourceType === 'deliverable' || /pdf|excel|xlsx|apresenta|formulario|planilha|arquivo/i.test(item.snippet))
    .flatMap((item) => extractDeliverableSignals(item.snippet))

  const values = dedupeItems([
    ...(topic.agentMemory?.deliverables ?? []).filter((item) => sanitizeAnswerText(item).length <= 120),
    ...summaryItems,
    ...citationItems,
  ]).filter(Boolean)

  if (values.length > 0) {
    return values.slice(0, 3)
  }

  return ['Nao encontrei isso no material']
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
    steps.push(`Leia o resumo de ${input.topic.title} e transforme o objetivo em 2 ou 3 tarefas praticas.`)
  }

  steps.push('Abra o anexo principal para validar detalhes finos antes de executar.')

  if ((input.topic.agentMemory?.deliverables ?? []).length > 0) {
    steps.push(`Prepare primeiro os entregaveis principais: ${input.topic.agentMemory!.deliverables.slice(0, 2).join(' e ')}.`)
  } else {
    steps.push('Monte uma checklist curta com entregaveis, formato e validacoes finais.')
  }

  return dedupeItems(steps).slice(0, 3)
}

function buildAttentionItems(topic: PublicTopic, citations: Citation[]) {
  const fromFacts = (topic.agentMemory?.keyFacts ?? [])
    .filter((item) => /atras|atenc|maximo|zero|abnt|sem|cancela|penalidade|avali|link|nota|erro/i.test(item))
  if (fromFacts.length > 0) {
    return fromFacts.slice(0, 3)
  }

  const fromCitations = citations
    .map((item) => item.snippet)
    .filter((item) => /atras|atenc|maximo|zero|abnt|sem|cancela|penalidade|avali|link|nota|erro/i.test(item))

  if (fromCitations.length > 0) {
    return fromCitations.slice(0, 3)
  }

  return ['Confirme os detalhes finos no anexo principal antes de entregar.']
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

  if (directLooksGeneric) {
    missingSections.push('RESPOSTA DIRETA')
  }

  switch (input.intent) {
    case 'deliverable':
      if (input.parsed.deliverables.length === 0 && !/entrega|arquivo|pdf|excel|anexo|nao encontrei/.test(combinedAll)) {
        missingSections.push('O QUE ENTREGAR')
      }
      break
    case 'grading':
    case 'format':
      if (input.parsed.attention.length === 0 && !/atras|penalidade|erro|abnt|nota|formato|risco|zero/.test(combinedAll)) {
        missingSections.push('ATENCAO')
      }
      break
    case 'tool_usage':
    case 'next_steps':
    case 'explanation':
    case 'unknown':
      if (!hasActionableStep(input.parsed.nextSteps) && !/\bfa(ca|ca|zer)|abra|prepare|confirme|ignore|foco|siga|valide|use\b/.test(combinedAll)) {
        missingSections.push('PROXIMO PASSO')
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
  return [
    `RESPOSTA DIRETA: ${sanitizeAnswerText(input.direct) || 'Nao encontrei isso no material'}`,
    `O QUE ENTREGAR: ${formatSectionItems(input.deliverables, 'Nao encontrei isso no material')}`,
    `ATENCAO: ${formatSectionItems(input.attention, 'Nao encontrei isso no material')}`,
    `PROXIMO PASSO: ${formatSectionItems(input.nextSteps, 'Nao encontrei isso no material')}`,
  ].join('\n')
}

function formatSectionItems(items: string[], fallback: string) {
  const visibleItems = dedupeItems(items.map((item) => sanitizeAnswerText(item))).filter(Boolean)
  if (visibleItems.length === 0) {
    return fallback
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

  if (intent === 'next_steps' || intent === 'explanation' || intent === 'unknown') {
    return ['Me faca um checklist', 'Explique este trabalho de forma simples', 'O que preciso entregar?']
  }

  return ['O que preciso entregar?', 'Me faca um checklist', 'O que pode me fazer perder pontos?']
}

function rankChunks(chunks: PublishedKnowledgeChunk[], question: string) {
  const tokens = tokenize(question)

  return chunks
    .map((chunk) => ({
      chunk,
      score: tokens.reduce((total, token) => {
        let nextTotal = total
        if (normalizeText(chunk.text).includes(token)) nextTotal += 1
        if (chunk.keywords.map((item) => normalizeText(item)).includes(token)) nextTotal += 2
        return nextTotal
      }, chunk.sourceType === 'faq' ? 1 : 0),
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
    results.push(...found.map((item) => sanitizeAnswerText(item)))
  }

  return dedupeItems(results).filter((item) => item.length <= 120)
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

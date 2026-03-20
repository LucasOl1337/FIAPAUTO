import fs from 'node:fs/promises'
import path from 'node:path'
import { botConfig } from '../bot/src/config.ts'
import type { AssignmentItem } from '../bot/src/types.ts'
import { readJsonFile } from '../bot/src/utils/fs.ts'
import {
  llmConfig,
  postLlmChat,
  uploadFilesToLlm,
  type LlmDocument,
  type LlmUploadResult,
} from './llmClient.ts'

export type AssignmentSummaryResult = {
  assignmentId: string
  moduleKey: string
  summary: string
  warnings: string[]
  filesUsed: string[]
}

export type AssistantAnswerResult = {
  answer: string
  moduleKey: string
  assignmentIds: string[]
  warnings: string[]
}

type WorkspaceReport = {
  assignments: AssignmentItem[]
}

export async function summarizeAssignment(assignmentId: string) {
  const assignment = await findAssignmentById(assignmentId)
  const moduleKey = detectModuleKey(assignment)
  const context = await buildAssignmentContext([assignment])
  const jobId = `summary-${assignment.id}-${Date.now()}`

  const message = [
    'Voce e um assistente academico objetivo.',
    'Resuma a atribuicao em portugues do Brasil.',
    'Responda em no maximo 6 linhas.',
    'Inclua: objetivo, entregaveis, prazo, e pontos de atencao.',
    'Se alguma informacao estiver ausente, diga explicitamente que nao foi encontrada.',
  ].join(' ')

  const response = await postLlmChat({
    jobId,
    mode: 'default',
    message,
    documents: context.documents,
    images: context.images,
  })

  return {
    assignmentId: assignment.id,
    moduleKey,
    summary: response.content || 'Nao foi possivel gerar resumo para esta atribuicao.',
    warnings: context.warnings,
    filesUsed: context.filePaths,
  } satisfies AssignmentSummaryResult
}

export async function answerAssignmentsQuestion(input: {
  question: string
  assignmentId?: string
  moduleKey?: string
}) {
  const assignments = await selectAssignmentsForQuestion(input)
  const context = await buildAssignmentContext(assignments)
  const assignmentIds = assignments.map((item) => item.id)
  const moduleKey = input.moduleKey || detectModuleKey(assignments[0])
  const jobId = `ask-${Date.now()}`

  const message = [
    `Pergunta do usuario: ${input.question}`,
    'Responda em portugues do Brasil, em no maximo 5 linhas, com base apenas no contexto enviado.',
    'Se a resposta nao estiver no contexto, diga explicitamente que a informacao nao foi encontrada.',
    'Nao invente detalhes e nao use markdown.',
  ].join('\n')

  const response = await postLlmChat({
    jobId,
    mode: 'default',
    message,
    documents: context.documents,
    images: context.images,
  })

  return {
    answer: response.content || 'Nao foi possivel responder com o contexto atual.',
    moduleKey,
    assignmentIds,
    warnings: context.warnings,
  } satisfies AssistantAnswerResult
}

export function getLlmStatus() {
  return llmConfig()
}

async function readAssignments() {
  const report = await readJsonFile<WorkspaceReport>(botConfig.assignmentsFile, { assignments: [] })
  return report.assignments
}

async function findAssignmentById(assignmentId: string) {
  const assignments = await readAssignments()
  const assignment = assignments.find((item) => item.id === assignmentId)
  if (!assignment) {
    throw new Error('assignment_not_found')
  }
  return assignment
}

async function selectAssignmentsForQuestion(input: {
  question: string
  assignmentId?: string
  moduleKey?: string
}) {
  const assignments = await readAssignments()

  if (input.assignmentId) {
    const selected = assignments.find((item) => item.id === input.assignmentId)
    if (!selected) {
      throw new Error('assignment_not_found')
    }
    return [selected]
  }

  const byModule = input.moduleKey
    ? assignments.filter((item) => detectModuleKey(item) === input.moduleKey)
    : assignments

  const ranked = byModule
    .map((item) => ({ item, score: scoreAssignmentMatch(item, input.question) }))
    .sort((a, b) => b.score - a.score)
    .filter((item, index) => item.score > 0 || index < 3)
    .slice(0, 3)
    .map((item) => item.item)

  if (ranked.length > 0) {
    return ranked
  }

  if (assignments[0]) {
    return [assignments[0]]
  }

  throw new Error('no_assignments_available')
}

async function buildAssignmentContext(assignments: AssignmentItem[]) {
  const warnings: string[] = []
  const documents: LlmDocument[] = []
  const filePaths = assignments.flatMap((assignment) => assignment.downloadedFiles).filter(Boolean)
  const uploadCandidatePaths: string[] = []

  for (const assignment of assignments) {
    documents.push({
      name: `${assignment.title}.metadata.txt`,
      content: [
        `titulo: ${assignment.title}`,
        `curso: ${assignment.course || 'nao identificado'}`,
        `status: ${assignment.status}`,
        `prazo: ${assignment.dueText || 'nao encontrado'}`,
        `detalhe: ${assignment.detailUrl || 'nao encontrado'}`,
        `modulo_sugerido: ${detectModuleKey(assignment)}`,
        `arquivos: ${assignment.downloadedFiles.map((item) => path.basename(item)).join(', ') || 'nenhum'}`,
      ].join('\n'),
    })
  }

  for (const filePath of filePaths) {
    const localDocument = await tryReadLocalTextFile(filePath)
    if (localDocument) {
      documents.push(localDocument)
      continue
    }

    uploadCandidatePaths.push(filePath)
  }

  let uploadData: LlmUploadResult = { documents: [], images: [], errors: [] }
  if (uploadCandidatePaths.length > 0) {
    uploadData = await uploadFilesToLlm(`upload-${Date.now()}`, uploadCandidatePaths)
  }

  warnings.push(...uploadData.errors)

  return {
    documents: dedupeDocuments([...documents, ...uploadData.documents]),
    images: uploadData.images,
    warnings,
    filePaths,
  }
}

async function tryReadLocalTextFile(filePath: string) {
  const extension = path.extname(filePath).toLowerCase()
  if (!['.txt', '.md', '.json', '.csv', '.log', '.py', '.js', '.ts', '.tsx', '.jsx', '.r'].includes(extension)) {
    return null
  }

  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return {
      name: path.basename(filePath),
      content: content.slice(0, 12000),
    } satisfies LlmDocument
  } catch {
    return null
  }
}

function detectModuleKey(assignment: AssignmentItem | undefined) {
  if (!assignment) {
    return 'geral'
  }

  const source = [
    assignment.title,
    assignment.course,
    assignment.dueText,
    assignment.downloadedFiles.map((item) => path.basename(item)).join(' '),
  ]
    .join(' ')
    .toLowerCase()

  if (/\bapi\b|backend|node|server|banco|sql/.test(source)) {
    return 'backend'
  }

  if (/python|\.py\b|algoritmo|lista|for|while|matriz|input/.test(source)) {
    return 'backend'
  }

  if (/prompt|rag|modelo|llm|ia|inteligencia artificial/.test(source)) {
    return 'ia-aplicada'
  }

  if (/frontend|react|css|html|vite|interface/.test(source)) {
    return 'frontend'
  }

  if (/fundamentos|introducao|introdução|conceito|logica|lógica/.test(source)) {
    return 'fundamentos'
  }

  return 'geral'
}

function scoreAssignmentMatch(assignment: AssignmentItem, question: string) {
  const normalizedQuestionTokens = question
    .toLowerCase()
    .split(/[^a-z0-9à-ÿ]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3)

  const source = `${assignment.title} ${assignment.course} ${assignment.dueText}`.toLowerCase()

  return normalizedQuestionTokens.reduce((score, token) => {
    return source.includes(token) ? score + 2 : score
  }, detectModuleKey(assignment) === 'geral' ? 0 : 1)
}

function dedupeDocuments(items: LlmDocument[]) {
  const seen = new Set<string>()

  return items.filter((item) => {
    const key = `${item.name}::${item.content}`
    if (seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}

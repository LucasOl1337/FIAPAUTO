import path from 'node:path'
import { runtimePaths } from '../config/runtimePaths.ts'
import { readJsonFile, writeJsonFile } from '../database/fs.ts'

export type ConversationTurn = {
  question: string
  answer: string
  answeredAt: string
}

export type ConversationState = {
  topicId: string
  summary: string
  turns: ConversationTurn[]
  updatedAt: string
}

const maxTurns = 6

export async function readConversationState(topicId: string) {
  return readJsonFile<ConversationState | null>(getConversationFile(topicId), null)
}

export async function appendConversationTurn(topicId: string, turn: ConversationTurn) {
  const current = await readConversationState(topicId)
  const turns = [turn, ...(current?.turns ?? [])]
    .filter((item) => isUsefulConversationTurn(item.question, item.answer))
    .slice(0, maxTurns)
  const summary = buildConversationSummary(turns)

  const nextState: ConversationState = {
    topicId,
    summary,
    turns,
    updatedAt: turn.answeredAt,
  }

  await writeJsonFile(getConversationFile(topicId), nextState)
  return nextState
}

function buildConversationSummary(turns: ConversationTurn[]) {
  return turns
    .slice(0, 4)
    .reverse()
    .map((turn) => `Usuario: ${turn.question}\nAssistente: ${turn.answer}`)
    .join('\n\n')
    .slice(0, 2400)
}

function getConversationFile(topicId: string) {
  return path.join(runtimePaths.subjectsDir, topicId, 'conversation-state.json')
}

function isUsefulConversationTurn(question: string, answer: string) {
  const normalizedQuestion = question.trim().toLowerCase()
  if (!normalizedQuestion) {
    return false
  }

  if (/^(oi|ola|olá|ae|aee|teste|blz|ok)+$/.test(normalizedQuestion)) {
    return false
  }

  if (answer.trim().length < 20) {
    return false
  }

  return true
}

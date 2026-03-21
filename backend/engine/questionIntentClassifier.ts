export type QuestionIntent =
  | 'deadline'
  | 'deliverable'
  | 'format'
  | 'grading'
  | 'numbered_item'
  | 'summary'
  | 'next_steps'
  | 'explanation'
  | 'greeting'
  | 'unknown'

const intentRules: Array<{ intent: QuestionIntent; pattern: RegExp }> = [
  { intent: 'greeting', pattern: /\b(oi|ola|olá|eai|ae|aee|teste|blz|tudo bem)\b/i },
  { intent: 'numbered_item', pattern: /\b(topico|tópico|item|questao|questão|parte|exercicio|exercício)\s*(numero\s*)?\d+\b/i },
  { intent: 'deadline', pattern: /\b(prazo|data|deadline|entrega|quando)\b/i },
  { intent: 'deliverable', pattern: /\b(entregar|entregavel|entregaveis|arquivo|anexo|enviar|subir)\b/i },
  { intent: 'format', pattern: /\b(formato|pdf|doc|docx|excel|planilha|slides|apresentacao|abnt)\b/i },
  { intent: 'grading', pattern: /\b(nota|criterio|criterio|avaliacao|perder pontos|erro|penalidade)\b/i },
  { intent: 'summary', pattern: /\b(resumo|resumir|sobre o que|objetivo)\b/i },
  { intent: 'next_steps', pattern: /\b(checklist|passos|proximos passos|como comecar|como começar|o que fazer)\b/i },
  { intent: 'explanation', pattern: /\b(explica|explique|entenda|ajuda|como funciona|como resolver)\b/i },
]

export function classifyQuestionIntent(question: string): QuestionIntent {
  for (const rule of intentRules) {
    if (rule.pattern.test(question)) {
      return rule.intent
    }
  }

  return 'unknown'
}

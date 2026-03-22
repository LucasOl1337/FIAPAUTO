export type QuestionIntent =
  | 'deadline'
  | 'deliverable'
  | 'format'
  | 'grading'
  | 'numbered_item'
  | 'summary'
  | 'next_steps'
  | 'tool_usage'
  | 'off_topic_learning'
  | 'explanation'
  | 'greeting'
  | 'smalltalk_or_noise'
  | 'unknown'

const intentRules: Array<{ intent: QuestionIntent; pattern: RegExp }> = [
  { intent: 'smalltalk_or_noise', pattern: /^(teste|testes?|blz|beleza|ok|opa|oi|ola|eai|ae|aee|tudo bem|bom dia|boa tarde|boa noite)[!.? ]*$/i },
  { intent: 'numbered_item', pattern: /\b(topico|item|questao|parte|exercicio)\s*(numero\s*)?\d+\b/i },
  { intent: 'off_topic_learning', pattern: /\b(me ensina|me explique|quero aprender|como aprende[rm]?|o que e|o que é|conceito de|fundamentos? de)\s+(python|programacao|programação|algoritmo|ia|inteligencia artificial|estatistica|r\b|excel)\b/i },
  { intent: 'tool_usage', pattern: /\b(python|script|codigo|programacao|programar|r\b|excel\b|planilha\b|como usar|como aplicar|da para fazer com|usar nisso|usar isso)\b/i },
  { intent: 'deadline', pattern: /\b(prazo|data|deadline|entrega|quando|horario|vence)\b/i },
  { intent: 'deliverable', pattern: /\b(entregar|entregavel|entregaveis|arquivo|anexo|enviar|subir)\b/i },
  { intent: 'format', pattern: /\b(formato|pdf|doc|docx|excel|planilha|slides|apresentacao|abnt)\b/i },
  { intent: 'grading', pattern: /\b(nota|criterio|avaliacao|perder pontos|erro|penalidade|risco)\b/i },
  { intent: 'summary', pattern: /\b(resumo|resumir|sobre o que|objetivo)\b/i },
  { intent: 'next_steps', pattern: /\b(checklist|passos|proximos passos|como comecar|o que fazer|dica|dicas|sem dificuldade|como ir bem|como nao errar|facil)\b/i },
  { intent: 'explanation', pattern: /\b(explica|explique|entenda|ajuda|como funciona|como resolver|nao entendi)\b/i },
  { intent: 'greeting', pattern: /\b(oi|ola|eai|ae|aee)\b/i },
]

export function classifyQuestionIntent(question: string): QuestionIntent {
  for (const rule of intentRules) {
    if (rule.pattern.test(question)) {
      return rule.intent
    }
  }

  return 'unknown'
}

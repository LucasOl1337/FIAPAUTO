import type { WorkspaceState } from '../types'

const now = new Date().toISOString()

export const initialWorkspaceState: WorkspaceState = {
  lessons: [
    {
      id: 'lesson-rag',
      title: 'RAG aplicado ao checkpoint',
      discipline: 'LLMs',
      date: '2026-03-18',
      recordingReference: 'drive://fiap/aulas/rag-checkpoint.mp4',
      notes: 'Aula com foco em retrieval, chunks e metricas de avaliacao.',
      status: 'summarized',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'lesson-embeddings',
      title: 'Embeddings e busca vetorial',
      discipline: 'NLP',
      date: '2026-03-20',
      recordingReference: '',
      notes: 'Separar exemplos praticos para revisao da equipe.',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    },
  ],
  transcripts: [
    {
      id: 'transcript-rag',
      lessonId: 'lesson-rag',
      text:
        'Nesta aula discutimos retrieval augmented generation, definicao de chunks, avaliacao de recall e pipeline de resposta com contexto.',
      status: 'completed',
      provider: 'Demo External STT',
      processedAt: now,
    },
  ],
  summaries: [
    {
      id: 'summary-rag',
      lessonId: 'lesson-rag',
      topics: ['RAG', 'Chunks', 'Recall', 'Contexto de consulta'],
      actions: [
        'Revisar estrategia de chunking antes da entrega.',
        'Comparar recall e precision no experimento da sprint.',
      ],
      overview:
        'A aula consolidou a estrutura do pipeline RAG e destacou pontos de avaliacao para melhorar qualidade de resposta.',
      provider: 'Demo External LLM',
      generatedAt: now,
    },
  ],
  fragilities: [
    {
      id: 'fragility-rag-1',
      lessonId: 'lesson-rag',
      theme: 'Metricas de retrieval',
      priority: 'Alta',
      recommendation: 'Estudar recall, precision e criterios de avaliacao com um exemplo real da aula.',
    },
  ],
  materials: [
    {
      id: 'material-rag-1',
      lessonId: 'lesson-rag',
      title: 'Slides da aula de RAG',
      type: 'link',
      reference: 'https://example.com/slides-rag',
      done: false,
    },
    {
      id: 'material-rag-2',
      lessonId: 'lesson-rag',
      title: 'Revisar chunks antes do checkpoint',
      type: 'task',
      reference: 'Tarefa interna do grupo',
      done: false,
    },
  ],
}

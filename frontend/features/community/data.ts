import type { CommunitySnapshot } from './types.ts'

export const defaultCommunitySnapshot: CommunitySnapshot = {
  patchNotes: [
    {
      id: 'patch-2026-03-22-community-layout',
      title: 'Hub publico da comunidade compactado na tela inicial',
      description: 'A login page agora exibe patch notes, roadmap e ideias em uma unica dobra, com cards menores e scroll so dentro dos blocos.',
      type: 'novo',
      createdAt: '2026-03-22T22:10:00.000Z',
    },
    {
      id: 'patch-2026-03-22-community-interactions',
      title: 'Ideias e votos liberados sem login no LAB',
      description: 'Envio de ideias, upvote e downvote passaram a funcionar para visitantes com identificador anonimo persistente, pronto para evoluir para controle por IP no backend.',
      type: 'melhoria',
      createdAt: '2026-03-22T21:40:00.000Z',
    },
    {
      id: 'patch-2026-03-22-llm-quality',
      title: 'Melhoria na logica do LLM para elevar a qualidade das respostas',
      description: 'A cadeia de resposta ficou mais robusta para buscar contexto da materia, reduzir saidas fracas e entregar respostas mais claras e confiaveis.',
      type: 'melhoria',
      createdAt: '2026-03-22T20:55:00.000Z',
    },
    {
      id: 'patch-2026-03-22-answer-quality',
      title: 'Respostas publicas mais objetivas e alinhadas ao conteudo real',
      description: 'A experiencia passou a priorizar contexto completo da aula e nao apenas os anexos isolados, melhorando relevancia nas duvidas.',
      type: 'fix',
      createdAt: '2026-03-22T19:50:00.000Z',
    },
  ],
  roadmapItems: [
    {
      id: 'roadmap-profile-personalization',
      title: 'Personalizacao do perfil de cada usuario',
      description: 'Adaptar memoria, contexto e tom de resposta para otimizar a ajuda entregue a cada aluno.',
      status: 'em desenvolvimento',
      createdAt: '2026-03-22T22:00:00.000Z',
    },
    {
      id: 'roadmap-record-transcribe',
      title: 'Gravacao e transcricao automatica das aulas',
      description: 'Capturar a aula, transcrever o professor e consolidar o conteudo sem depender de upload manual.',
      status: 'em desenvolvimento',
      createdAt: '2026-03-22T21:00:00.000Z',
    },
    {
      id: 'roadmap-lesson-understanding',
      title: 'IA para entender tudo o que o professor explicou',
      description: 'Gerar contexto completo da materia a partir da explicacao real em aula, e nao so dos PDFs compartilhados.',
      status: 'em desenvolvimento',
      createdAt: '2026-03-22T20:30:00.000Z',
    },
    {
      id: 'roadmap-summaries',
      title: 'Resumos claros e objetivos a partir da aula real',
      description: 'Transformar a explicacao do professor em resumos acionaveis, diretos e conectados ao momento da disciplina.',
      status: 'em desenvolvimento',
      createdAt: '2026-03-22T19:40:00.000Z',
    },
    {
      id: 'roadmap-qa-real-content',
      title: 'Duvidas respondidas com base no conteudo real da aula',
      description: 'Permitir perguntas sobre a materia com referencia ao que foi explicado, criando um contexto completo alem dos anexos.',
      status: 'em desenvolvimento',
      createdAt: '2026-03-22T18:50:00.000Z',
    },
  ],
  ideas: [],
  votes: [],
}

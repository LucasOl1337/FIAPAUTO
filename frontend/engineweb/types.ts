export type ModuleKey =
  | 'aulas'
  | 'transcricao'
  | 'resumos'
  | 'fragilidades'
  | 'organizacao'
  | 'bot'

export type LessonStatus =
  | 'draft'
  | 'recorded'
  | 'transcribing'
  | 'transcribed'
  | 'summarizing'
  | 'summarized'

export type MaterialType = 'link' | 'task' | 'note'

export type Priority = 'Alta' | 'Media' | 'Baixa'

export interface Lesson {
  id: string
  title: string
  discipline: string
  date: string
  recordingReference: string
  notes: string
  status: LessonStatus
  createdAt: string
  updatedAt: string
}

export interface Transcript {
  id: string
  lessonId: string
  text: string
  status: 'pending' | 'completed' | 'failed'
  provider: string
  processedAt: string
}

export interface Summary {
  id: string
  lessonId: string
  topics: string[]
  actions: string[]
  overview: string
  provider: string
  generatedAt: string
}

export interface Fragility {
  id: string
  lessonId: string
  theme: string
  priority: Priority
  recommendation: string
}

export interface CourseMaterial {
  id: string
  lessonId: string
  title: string
  type: MaterialType
  reference: string
  done: boolean
}

export interface WorkspaceState {
  lessons: Lesson[]
  transcripts: Transcript[]
  summaries: Summary[]
  fragilities: Fragility[]
  materials: CourseMaterial[]
}

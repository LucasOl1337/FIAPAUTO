import './App.css'

const highlights = [
  {
    title: 'Gravacao automatica das aulas',
    description:
      'Pipeline para capturar encontros ao vivo e transformar cada aula em um ativo consultavel.',
  },
  {
    title: 'Transcricao e resumo inteligente',
    description:
      'Conversao de audio para texto, extracao de topicos-chave e resumos acionaveis por aula.',
  },
  {
    title: 'Diagnostico de fragilidades',
    description:
      'Leitura do historico de estudo para apontar lacunas, recomendar revisoes e sugerir proximos passos.',
  },
]

const metrics = [
  { label: 'Aulas indexadas', value: '128' },
  { label: 'Horas transcritas', value: '312h' },
  { label: 'Alertas de revisao', value: '19' },
]

const modules = [
  'Captura de aulas ao vivo e gravacao sob demanda',
  'Transcricao com segmentacao por assunto e timestamp',
  'Resumos com insights, tarefas e glossario',
  'Biblioteca de materiais, links e entregas do curso',
  'Recomendacoes personalizadas de estudo',
  'Mapa de fragilidades por disciplina e habilidade',
]

const studyFeed = [
  {
    tag: 'Hoje',
    title: 'Revisar fundamentos de embeddings',
    detail: 'A IA detectou baixa retencao nas ultimas duas aulas de NLP.',
  },
  {
    tag: 'A seguir',
    title: 'Gerar cards de revisao da sprint atual',
    detail: 'Transformar topicos-chave das aulas em revisoes curtas.',
  },
  {
    tag: 'Equipe',
    title: 'Compartilhar resumo da aula de agentes',
    detail: 'Publicar highlights e decisoes no espaco colaborativo do projeto.',
  },
]

function App() {
  return (
    <main className="app-shell">
      <section className="hero-section">
        <div className="hero-copy">
          <div className="eyebrow">FIAPAUTO · AI Course Operating System</div>
          <h1>Centralize aulas, transcricoes, resumos e evolucao de estudo em um unico lugar.</h1>
          <p className="hero-text">
            Um hub para o curso de IA da FIAP que grava aulas automaticamente, converte audio em texto,
            destaca o que importa e organiza os proximos passos de aprendizagem para cada aluno.
          </p>

          <div className="hero-actions">
            <button type="button" className="primary-action">
              Criar workspace do curso
            </button>
            <button type="button" className="secondary-action">
              Ver arquitetura inicial
            </button>
          </div>

          <div className="metrics-grid">
            {metrics.map((metric) => (
              <article key={metric.label} className="metric-card">
                <strong>{metric.value}</strong>
                <span>{metric.label}</span>
              </article>
            ))}
          </div>
        </div>

        <div className="hero-panel">
          <div className="panel-window">
            <div className="panel-header">
              <span className="dot coral"></span>
              <span className="dot gold"></span>
              <span className="dot mint"></span>
              <p>Monitor de aula em tempo real</p>
            </div>

            <div className="capture-card">
              <div>
                <span className="status-chip live">Ao vivo</span>
                <h2>Machine Learning Engineering</h2>
                <p>Captura em andamento com separacao automatica por topico e timeline inteligente.</p>
              </div>
              <div className="waveform" aria-hidden="true">
                <span></span>
                <span></span>
                <span></span>
                <span></span>
                <span></span>
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>

            <div className="summary-card">
              <div className="summary-heading">
                <span className="status-chip ready">Resumo gerado</span>
                <span>89% de confianca</span>
              </div>

              <ul>
                <li>Conceitos centrais: fine-tuning, RAG e avaliacao de modelos.</li>
                <li>Pendencia detectada: revisar metricas de retrieval antes do checkpoint.</li>
                <li>Acao sugerida: abrir trilha de estudo complementar com foco em vetores.</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="content-grid">
        <article className="glass-card">
          <div className="section-label">Proposta de valor</div>
          <h3>O produto nasce para reduzir atrito no acompanhamento do curso.</h3>
          <div className="highlight-list">
            {highlights.map((item) => (
              <div key={item.title} className="highlight-item">
                <h4>{item.title}</h4>
                <p>{item.description}</p>
              </div>
            ))}
          </div>
        </article>

        <article className="glass-card">
          <div className="section-label">Mapa inicial do sistema</div>
          <h3>Modulos que ja orientam o backlog do projeto.</h3>
          <ul className="module-list">
            {modules.map((module) => (
              <li key={module}>{module}</li>
            ))}
          </ul>
        </article>
      </section>

      <section className="workspace-section">
        <article className="workspace-panel">
          <div className="section-label">Workspace do aluno</div>
          <h3>Recomendacoes de estudo orientadas por comportamento real.</h3>
          <p>
            A interface cruza aulas assistidas, materiais consultados, resumos recentes e sinais de
            dificuldade para propor revisoes objetivas e priorizadas.
          </p>

          <div className="feed-list">
            {studyFeed.map((item) => (
              <div key={item.title} className="feed-item">
                <span>{item.tag}</span>
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="roadmap-panel">
          <div className="section-label">Roadmap imediato</div>
          <h3>Primeiras entregas para transformar ideia em produto.</h3>
          <ol>
            <li>Definir fluxo de captura e ingestao das aulas.</li>
            <li>Estruturar pipeline de transcricao e sumarizacao.</li>
            <li>Modelar dashboard com aulas, resumos e recomendacoes.</li>
            <li>Planejar camada colaborativa para equipe e professores.</li>
          </ol>
        </article>
      </section>
    </main>
  )
}

export default App

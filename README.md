# FIAPAUTO

FIAPAUTO e a base de um produto para apoiar o curso de IA da FIAP com automacao de aulas, organizacao academica e acompanhamento inteligente do estudo.

## Visao do produto

O objetivo do projeto e concentrar em um unico sistema:

- gravacao automatica das aulas
- transcricao de audio para texto
- resumo com topicos-chave e proximos passos
- organizacao de materiais, links, tarefas e entregas
- recomendacoes de estudo personalizadas
- analise de fragilidades por tema, disciplina ou habilidade

## Stack inicial

- React 19
- TypeScript
- Vite
- CSS customizado
- Persistencia local com `localStorage`
- Pipeline desacoplado em camada de servico demo

## Como rodar

```bash
npm install
npm run dev
```

Ou, no Windows, execute:

```bat
launch.bat
```

Tambem existe a versao PowerShell:

```powershell
.\launch.ps1
```

## Roadmap inicial

1. Definir arquitetura de captura e ingestao das aulas.
2. Escolher pipeline de transcricao e sumarizacao.
3. Estruturar o dashboard principal com dados reais.
4. Evoluir para uma camada de recomendacao e analise de desempenho.

## MVP atual

O projeto agora possui uma demo funcional ponta a ponta no frontend:

- cadastro manual de aulas
- simulacao de gravacao
- transcricao assincrona via servico demo
- geracao de resumo e fragilidades via servico demo
- organizacao de materiais e tarefas por aula
- persistencia local para manter o estado da demo entre recarregamentos

## Estrutura do projeto

- `src/App.tsx`: dashboard principal e interacoes
- `src/types.ts`: entidades principais do MVP
- `src/lib/demoPipeline.ts`: camada de servico para transcricao e resumo
- `src/lib/storage.ts`: persistencia local
- `docs/PROJECT_BRIEF.md`: alinhamento rapido para equipe

## Colaboracao

Projeto pensado para trabalho em equipe desde o inicio, com repositorio GitHub e uma UI inicial para alinhar produto, backlog e visao.

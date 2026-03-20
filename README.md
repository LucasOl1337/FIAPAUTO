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

Agora `npm run dev` sobe:

- frontend do site
- API local do bot

Portas usadas por este projeto:

- webapp: `127.0.0.1:43871`
- API local: `127.0.0.1:43872`

Com isso, o teste do bot pode ser feito direto pela interface do site no modulo `Bot`.

Ou, no Windows, execute:

```bat
launch.bat
```

Tambem existe a versao PowerShell:

```powershell
.\launch.ps1
```

Agora tambem existe um orquestrador em Python com painel de console e logs em tempo real:

```bash
python launcher.py
```

O launcher sobe a API e o frontend, acompanha a saida em tempo real, monitora o arquivo `bot/output/automation.log` e exibe tudo em um painel colorido com atalhos:

- `o`: abre o site no navegador
- `a`: reinicia a API
- `w`: reinicia o frontend
- `b`: liga ou desliga o worker do bot
- `r`: reinicia todos os servicos ativos
- `q`: encerra o launcher

## Bot de gravacao

O projeto agora tem um esqueleto isolado para o bot de aulas no Microsoft Teams usando Playwright.

```bash
npm run bot:test
```

Esse comando executa um teste rapido com fixture local e gera artefatos em `bot/output`.

Tambem e possivel testar pelo proprio site:

1. rode `npm run dev`
2. abra `http://127.0.0.1:43871`
3. entre no modulo `Bot`
4. clique em `Executar bot demo`
5. a aula gerada aparece no site pronta para transcricao

Para rodar em modo worker:

```bash
npm run bot:worker
```

## Assistente de atribuicoes com LLM

O projeto agora consegue usar um servico LLM HTTP no mesmo estilo ja usado no `lojasync`.

Configuracao por variaveis de ambiente:

- `LLM_BASE_URL`: URL base do servico compatível com Ollama
- `LLM_API_KEY`: token Bearer do servico, quando necessario
- `LLM_MODEL`: nome do modelo, opcional
- `LLM_HTTP_TIMEOUT_MS`: timeout das chamadas HTTP

Se essas variaveis nao estiverem definidas, o projeto tenta reaproveitar as chaves ja cadastradas em:

- `C:\Users\user\Desktop\lojasync\Legacy\engine\LLM3\keys.py`

Nesse caso, o `FIAPAUTO` passa a usar `https://ollama.com` automaticamente, seguindo a mesma logica do `lojasync`.

Exemplo no PowerShell antes de rodar o projeto:

```powershell
$env:LLM_BASE_URL="https://seu-servico-ollama-cloud"
$env:LLM_API_KEY="seu-token"
$env:LLM_MODEL="qwen2.5:7b-instruct"
npm run dev
```

Fluxo disponivel na aba `Trabalhos`:

1. conectar o Teams
2. executar a varredura
3. selecionar uma atribuicao
4. clicar em `Resumir com LLM`
5. fazer perguntas sobre a atribuicao no painel do assistente

Endpoints locais adicionados:

- `POST /api/assistant/summary`
- `POST /api/assistant/ask`

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
- `docs/BOT_MODULE.md`: estrutura inicial do bot de gravacao
- `bot/`: modulo isolado do worker de automacao para Teams

## Colaboracao

Projeto pensado para trabalho em equipe desde o inicio, com repositorio GitHub e uma UI inicial para alinhar produto, backlog e visao.

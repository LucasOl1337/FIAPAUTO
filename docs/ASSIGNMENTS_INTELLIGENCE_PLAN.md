# Plano de Inteligencia Local para Atribuicoes

## Contexto atual

O projeto ja possui um fluxo inicial de captura de atribuicoes no Teams:

- varredura do workspace autenticado
- identificacao de cards de atribuicao
- abertura do detalhe de cada item
- download de materiais de referencia
- persistencia do relatorio em JSON

Hoje isso passa principalmente por:

- `backend/bots/src/platforms/teams/TeamsMeetingAdapter.ts`
- `backend/database/TeamsWorkspaceStore.ts`
- `backend/runtime/jobs/assignments-report.json`
- `backend/runtime/downloads/...`

## Objetivo da proxima etapa

Depois da extracao, o sistema deve:

1. ler o conteudo de todas as atribuicoes e seus anexos
2. separar tudo por modulo do site
3. gerar um resumo curto de cada atribuicao
4. permitir que o usuario tire duvidas sobre uma atribuicao ou modulo
5. funcionar sem API paga de IA

## Arquitetura recomendada

### 1. Camada de coleta

Responsavel por continuar fazendo o que o bot ja faz hoje:

- listar atribuicoes
- abrir detalhes
- baixar anexos
- salvar metadados

Saidas recomendadas:

- `backend/runtime/assignments/raw/assignments-report.json`
- `backend/runtime/assignments/raw/<assignment-id>/metadata.json`
- `backend/runtime/assignments/raw/<assignment-id>/attachments/...`
- `backend/runtime/assignments/raw/<assignment-id>/page.html` quando possivel
- `backend/runtime/assignments/raw/<assignment-id>/screenshot.png` opcional

### 2. Camada de normalizacao

Responsavel por transformar cada atribuicao em um formato unico, independentemente do tipo de anexo.

Formato sugerido:

```json
{
  "id": "atrib-001",
  "title": "Checkpoint 1",
  "course": "IA para Devs",
  "moduleKey": "fase-1-fundamentos",
  "status": "upcoming",
  "dueAtText": "Prazo de entrega: 25/03/2026",
  "sourceUrl": "https://...",
  "attachments": [
    {
      "fileName": "enunciado.pdf",
      "path": "backend/runtime/assignments/raw/atrib-001/attachments/enunciado.pdf",
      "mimeType": "application/pdf"
    }
  ],
  "capturedText": "...texto da pagina da atribuicao..."
}
```

### 3. Camada de extracao de texto

Responsavel por ler o conteudo textual dos anexos e da propria pagina.

Prioridade:

- HTML: extrair com parser simples
- PDF texto: usar biblioteca local
- DOCX: extrair XML interno
- TXT/MD: leitura direta
- imagem escaneada: deixar para fase 2, com OCR local apenas se necessario

Saida:

- `backend/runtime/assignments/processed/<assignment-id>/content.json`
- `backend/runtime/assignments/processed/<assignment-id>/fulltext.txt`

### 4. Camada de classificacao por modulo

Responsavel por descobrir em qual modulo do site cada atribuicao entra.

Comecar simples:

- mapa manual por disciplina/curso
- regras por palavras-chave
- fallback para `modulo-geral`

Exemplo de regras:

- se titulo ou conteudo tiver "fase 1", "fundamentos", "introducao" -> `fundamentos`
- se tiver "api", "backend", "node" -> `backend`
- se tiver "modelo", "prompt", "rag" -> `ia-aplicada`

Depois evoluir para classificacao semantica local.

Saidas:

- `backend/runtime/assignments/index/modules.json`
- `backend/runtime/assignments/index/by-module/<moduleKey>.json`

### 5. Camada de resumo

Responsavel por gerar um resumo curto e padronizado para cada atribuicao.

Formato sugerido:

```json
{
  "assignmentId": "atrib-001",
  "summary": "Trabalho sobre fundamentos de IA com foco em conceitos basicos e entrega de relatorio.",
  "deliverables": ["relatorio", "codigo-fonte"],
  "importantDates": ["25/03/2026"],
  "topics": ["introducao a IA", "conceitos basicos"],
  "openQuestions": ["confirmar formato do relatorio"]
}
```

## Como fazer a inteligencia sem API paga

## Opcao A: sem LLM no inicio

Mais barata e mais robusta para MVP.

Componentes:

- parser de texto
- regras por palavras-chave
- busca full-text local
- templates de resposta

Fluxo:

1. o usuario pergunta algo
2. o sistema identifica modulo e atribuicao por palavras-chave
3. busca trechos relevantes no indice local
4. responde com base em snippets e estrutura fixa

Vantagens:

- custo zero
- simples de manter
- rapido para colocar em producao

Limites:

- respostas menos naturais
- menor capacidade de inferencia

## Opcao B: RAG local com modelo rodando na propria maquina

Melhor experiencia, ainda sem custo por chamada.

Stack sugerida:

- Ollama para servir modelos locais
- modelo de chat leve:
  - `qwen2.5:3b-instruct`
  - `qwen2.5:7b-instruct`
  - `llama3.1:8b` se a maquina aguentar
- embeddings locais:
  - `nomic-embed-text`
  - ou busca BM25 sem embeddings na primeira versao

Fluxo:

1. indexar textos das atribuicoes por chunks
2. recuperar os trechos mais relevantes
3. mandar apenas esses trechos para o modelo local
4. responder com instrucoes para:
   - resumir
   - explicar a atribuicao
   - responder duvidas do usuario
   - avisar quando faltar contexto

Vantagens:

- melhor qualidade de resposta
- custo financeiro zero por uso
- evolui bem para assistente por modulo

Limites:

- depende de hardware
- resposta mais lenta em CPU

## Recomendacao pragmatica

Fase 1:

- sem LLM
- usar busca textual + regras + resumo deterministico

Fase 2:

- adicionar Ollama opcional
- ativar resumo e FAQ com modelo local apenas quando disponivel

Assim o produto nasce funcional mesmo sem GPU e sem custo mensal.

## Estrategia de "um bot por modulo"

Nao precisa criar varios processos separados no inicio.

Melhor abordagem:

- um unico motor de resposta
- um indice separado por modulo
- uma persona/configuracao por modulo

Exemplo:

- modulo `fundamentos`: explica conceitos basicos e termos iniciais
- modulo `backend`: prioriza requisitos tecnicos e entregaveis de codigo
- modulo `ia-aplicada`: prioriza contexto de modelos, prompts e avaliacao

Cada modulo pode ter:

- propria pasta de documentos indexados
- proprio arquivo de instrucoes
- proprio conjunto de FAQ

Estrutura sugerida:

- `backend/runtime/knowledge/modules/fundamentos/...`
- `backend/runtime/knowledge/modules/backend/...`
- `backend/runtime/knowledge/modules/ia-aplicada/...`
- `backend/engine/module-prompts/<moduleKey>.md`

## Pipeline tecnico sugerido

1. `scanWorkspace()`
2. salvar relatorio bruto
3. processar cada atribuicao nova
4. extrair texto dos anexos
5. classificar modulo
6. gerar resumo curto
7. atualizar indice por modulo
8. disponibilizar endpoint de consulta para a UI

## Endpoints futuros recomendados

- `POST /api/assignments/process`
- `GET /api/assignments/modules`
- `GET /api/assignments/module/:moduleKey`
- `GET /api/assignments/:assignmentId`
- `POST /api/assistant/ask`

## Estrutura de resposta do assistente

```json
{
  "answer": "Resumo da resposta ao usuario.",
  "moduleKey": "fundamentos",
  "assignmentIds": ["atrib-001"],
  "citations": [
    {
      "assignmentId": "atrib-001",
      "snippet": "Trecho usado para responder"
    }
  ],
  "confidence": "high"
}
```

## Regras importantes para confiabilidade

- nunca inventar informacoes ausentes
- sempre citar a atribuicao usada
- quando houver duvida, responder que a informacao nao foi encontrada
- registrar de qual anexo ou pagina veio cada trecho

## Roadmap recomendado

### Etapa 1 - consolidar extracao

- estabilizar captura de todas as atribuicoes
- salvar HTML/texto da pagina da atribuicao
- padronizar nomes de pasta e IDs

### Etapa 2 - processar conteudo

- criar pipeline de extracao de texto
- gerar `content.json` e `fulltext.txt`
- classificar por modulo

### Etapa 3 - inteligencia MVP sem IA paga

- implementar busca local
- montar resumo por template
- criar FAQ simples por modulo

### Etapa 4 - inteligencia local opcional

- integrar Ollama
- gerar resumo mais natural
- responder perguntas abertas com RAG local

## Escolha recomendada agora

Para o momento do projeto, a melhor decisao e:

1. aproveitar a extracao atual do Playwright
2. criar uma camada nova de processamento offline
3. comecar com busca + regras + snippets
4. deixar o uso de modelo local como upgrade opcional

Isso reduz risco, nao cria custo recorrente e entrega valor rapido.

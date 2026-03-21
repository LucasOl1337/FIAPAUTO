# Patch Notes - v0.2

Data: 21/03/2026

## Resumo da versao
A v0.2 marca a transicao do projeto de um extrator de trabalhos para um assistente academico funcional.

O foco desta versao foi:
- tornar o chat mais util para o aluno
- melhorar a leitura da interface
- criar contexto persistido por atividade
- adicionar a nova camada de `Aprendizado`

## Principais novidades
### 1. Assistente academico hibrido
- pipeline de resposta com classificacao de intencao
- contexto curto por topico
- suporte a provedor em nuvem
- fallback local deterministico

### 2. Respostas melhores para itens numerados
- identificacao de perguntas como `como resolver o topico 4`
- extracao do item certo do material
- resposta mais concreta e menos generica

### 3. UI mais amigavel para o aluno
- resumo mais legivel
- entregaveis mais limpos
- prazo exibido como data quando possivel
- acesso rapido ao PDF principal

### 4. Nova aba `Aprendizado`
Gerada automaticamente para cada atividade extraida, com:
- duvidas frequentes
- conceitos simples
- dicas rapidas

### 5. Memoria persistida mais segura
- filtro de perguntas vagas
- reducao de respostas toxicas/poluentes na memoria
- menor reaproveitamento de FAQ ruim

## Melhorias tecnicas
- reorganizacao do monorepo em `frontend`, `backend` e `backend/bots`
- runtime consolidado em `backend/runtime`
- contratos mais ricos entre frontend e backend
- documentacao visual com imagens no repositorio

## Screenshots desta versao
### Hero
![Hero](docs/assets/hero.png)

### Workspace do Teams
![Teams Workspace](docs/assets/teams-workspace.png)

### Lista de topicos
![Checkpoint List](docs/assets/checkpoint-1-list.png)

### Tela de detalhe do trabalho
![Checkpoint Detail](docs/assets/checkpoint-1-detail.png)

### Exemplo adicional
![Cloud Security Detail](docs/assets/cloud-security-detail.png)

## Limites ainda conhecidos
- extracao de entregaveis ainda pode melhorar em alguns tipos de PDF
- varias atividades ainda dependem de OCR/conteudo parcial
- admin e usuario ainda compartilham o mesmo webapp

## Proximo alvo da v0.3
- separar webapp admin e webapp user
- reforcar seguranca no backend admin
- melhorar ainda mais a geracao automatica do aprendizado
- enriquecer a experiencia publica para deploy em nuvem

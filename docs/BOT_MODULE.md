# Bot de Gravacao - Estrutura Inicial

## Objetivo
Automatizar o fluxo:

`aula agendada -> entrada no Teams -> gravacao -> upload -> pronto para transcricao`

## Estrutura
- `backend/automations`: scheduler, runtime e entrada do worker
- `backend/bots/src/core`: orquestracao do job
- `backend/bots/src/platforms/teams`: automacao via Playwright
- `backend/bots/src/services`: gravacao, upload e servicos do bot
- `backend/bots/src/config.ts`: configuracao base e jobs demo
- `backend/bots/fixtures/mock-teams-meeting.html`: pagina local para teste rapido

## Comandos
```bash
npm run bot:test
npm run bot:worker
```

## O que o teste rapido faz
- carrega um job demo de aula no Teams
- abre uma fixture local com Playwright
- simula entrada na reuniao
- gera um artefato de gravacao fake
- copia o arquivo para a pasta de upload
- marca a aula como pronta para transcricao

## Pastas de saida
- `backend/runtime/jobs/jobs-state.json`
- `backend/runtime/jobs/ready-lessons.json`
- `backend/runtime/recordings`
- `backend/runtime/uploads`
- `backend/runtime/screenshots`

## Proximos passos
1. Trocar fixture por login real no Teams.
2. Integrar FFmpeg ou captura real de audio/video.
3. Enviar upload para backend/storage do projeto.
4. Sincronizar jobs com aulas cadastradas no site.

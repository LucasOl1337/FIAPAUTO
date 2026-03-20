# Bot de Gravacao - Estrutura Inicial

## Objetivo
Automatizar o fluxo:

`aula agendada -> entrada no Teams -> gravacao -> upload -> pronto para transcricao`

## Estrutura
- `bot/src/core`: scheduler e orquestracao do job
- `bot/src/platforms/teams`: adapter de automacao via Playwright
- `bot/src/services`: gravacao, upload e persistencia local
- `bot/src/config.ts`: configuracao base e jobs demo
- `bot/fixtures/mock-teams-meeting.html`: pagina local para teste rapido

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
- `bot/output/jobs-state.json`
- `bot/output/ready-lessons.json`
- `bot/output/recordings`
- `bot/output/uploads`
- `bot/output/screenshots`

## Proximos passos
1. Trocar fixture por login real no Teams.
2. Integrar FFmpeg ou captura real de audio/video.
3. Enviar upload para backend/storage do projeto.
4. Sincronizar jobs com aulas cadastradas no site.

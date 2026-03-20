# FIAPAUTO - MVP Brief

## Objetivo
Criar uma demo funcional para o grupo de alunos da FIAP que mostre o fluxo:

`aula -> gravacao/referencia -> transcricao -> resumo -> fragilidades`

## Modulos do MVP
- Aulas
- Transcricao
- Resumos
- Fragilidades
- Organizacao

## O que ja deve existir no projeto
- dashboard compacto em uma viewport principal
- cadastro manual de aulas
- persistencia local para demo
- pipeline desacoplado da UI
- geracao de transcricao, resumo e fragilidades via camada de servico

## Divisao de trabalho sugerida
### Frontend e UX
- navegacao do dashboard
- componentes e formularios
- estados visuais do pipeline
- experiencia de uso e refinamento de layout

### Dados e integracoes
- modelo de dados
- servicos de pipeline
- integracao futura com APIs externas
- regras de status e processamento

## Proximos passos
1. Trocar servicos demo por provedores reais.
2. Adicionar backend/persistencia remota.
3. Evoluir organizacao do curso e colaboracao.

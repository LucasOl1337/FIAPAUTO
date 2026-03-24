# Deploy publico com Amplify + Lambda

## O que este fluxo sobe

- `apps/web-public` no AWS Amplify Hosting
- `backend/cloud/handlers/publicApi.ts` como Lambda + API Gateway usando `aws/template.yaml`

Este repo **nao** sobe o `services/public-api` inteiro dentro do Amplify Hosting. O caminho cloud pronto hoje para o app publico e `Amplify frontend + Lambda/API Gateway`.

## 1. Frontend no Amplify

No Amplify Hosting:

- repo: este repositorio
- branch: `main`
- app root: `apps/web-public`
- variavel obrigatoria: `AMPLIFY_MONOREPO_APP_ROOT=apps/web-public`

Variaveis de ambiente do frontend:

- `VITE_PUBLIC_API_BASE_URL=https://<api-id>.execute-api.<region>.amazonaws.com/api/public`
- `VITE_PUBLIC_AUTH_MODE=none`

O `amplify.yml` da raiz ja esta preparado para buildar `apps/web-public`.

## 2. Backend publico como Lambda

Copie o arquivo [`aws/.env.public-api.example`](/C:/Users/user/Desktop/FIAPAUTO/aws/.env.public-api.example) para `aws/.env.public-api` e preencha:

- `FIAPAUTO_PUBLIC_BUCKET`
- `FIAPAUTO_LAMBDA_ARTIFACT_BUCKET`
- `FIAPAUTO_LAMBDA_EXECUTION_ROLE_ARN`
- `FIAPAUTO_FRONTEND_ORIGIN`

O role informado em `FIAPAUTO_LAMBDA_EXECUTION_ROLE_ARN` precisa existir antes do deploy.

## 3. Deploy local do backend publico

```bash
npm ci --include=dev
npm run cloud:deploy:public-api
```

Esse comando:

1. gera o bundle Lambda
2. cria `aws/dist/public-api.zip`
3. envia o artefato para S3
4. executa `aws cloudformation deploy` usando `aws/template.yaml`
5. imprime a `PublicApiBaseUrl`

## 4. Deploy por GitHub Actions

Workflow disponivel:

- [`.github/workflows/deploy-public-api.yml`](/C:/Users/user/Desktop/FIAPAUTO/.github/workflows/deploy-public-api.yml)

Secrets necessarios:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `FIAPAUTO_PUBLIC_BUCKET`
- `FIAPAUTO_LAMBDA_ARTIFACT_BUCKET`
- `FIAPAUTO_LAMBDA_EXECUTION_ROLE_ARN`
- `FIAPAUTO_FRONTEND_ORIGIN`

Variaveis opcionais do repo:

- `FIAPAUTO_AWS_REGION`
- `FIAPAUTO_PUBLIC_API_STACK_NAME`
- `FIAPAUTO_LAMBDA_ARTIFACT_KEY`

Depois do workflow concluir, pegue a `PublicApiBaseUrl` do stack e configure esse valor em `VITE_PUBLIC_API_BASE_URL` no Amplify.

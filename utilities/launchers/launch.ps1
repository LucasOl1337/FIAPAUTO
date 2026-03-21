$ErrorActionPreference = 'Stop'

$rootDir = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $rootDir

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js nao foi encontrado no sistema.'
  Write-Host 'Instale o Node.js e tente novamente.'
  Read-Host 'Pressione Enter para sair'
  exit 1
}

if (-not (Test-Path (Join-Path $rootDir 'node_modules'))) {
  Write-Host 'Instalando dependencias...'
  npm install
}

Write-Host 'Iniciando FIAPAUTO em modo desenvolvimento...'
npm run dev

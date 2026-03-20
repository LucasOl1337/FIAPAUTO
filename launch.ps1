$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js nao foi encontrado no sistema.'
  Write-Host 'Instale o Node.js e tente novamente.'
  Read-Host 'Pressione Enter para sair'
  exit 1
}

if (-not (Test-Path "$PSScriptRoot\node_modules")) {
  Write-Host 'Instalando dependencias...'
  npm install
}

Write-Host 'Iniciando FIAPAUTO em modo desenvolvimento...'
Start-Process 'http://127.0.0.1:43871'
npm run dev

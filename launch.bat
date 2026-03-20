@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao foi encontrado no sistema.
  echo Instale o Node.js e tente novamente.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Instalando dependencias...
  call npm install
  if errorlevel 1 (
    echo Falha ao instalar dependencias.
    pause
    exit /b 1
  )
)

echo Iniciando FIAPAUTO em modo desenvolvimento...
call npm run dev

if errorlevel 1 (
  echo O projeto foi encerrado com erro.
  pause
  exit /b 1
)

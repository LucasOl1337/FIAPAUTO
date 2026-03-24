@echo off
setlocal

set "CLOUDFLARED=%LOCALAPPDATA%\Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe"
set "LOG=%~dp0..\..\cloudflared-ollama-tunnel.log"

"%CLOUDFLARED%" tunnel --url http://127.0.0.1:11434 --http-host-header 127.0.0.1:11434 --no-autoupdate --loglevel info --logfile "%LOG%"

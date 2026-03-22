$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

$apiPort = 43878
$runtimeDir = Join-Path $repoRoot 'backend\runtime\public-stack'
$apiLog = Join-Path $repoRoot 'backend-api-public.log'
$apiErrLog = Join-Path $repoRoot 'backend-api-public.err.log'
$tunnelLog = Join-Path $repoRoot 'cloudflared.log'
$tunnelErrLog = Join-Path $repoRoot 'cloudflared.err.log'
$statusFile = Join-Path $runtimeDir 'status.json'
$cloudflaredPath = Join-Path $repoRoot 'tools\cloudflared.exe'

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

function Write-Status($status) {
  $status | ConvertTo-Json -Depth 5 | Set-Content -Path $statusFile -Encoding UTF8
}

function Stop-PortOwner($port) {
  $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($connection in $connections) {
    try {
      Stop-Process -Id $connection.OwningProcess -Force -ErrorAction Stop
    } catch {
      # Ignore stale listeners or protected processes.
    }
  }
}

function Wait-ForHttp($url, $timeoutSeconds = 20) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        return $true
      }
    } catch {
      Start-Sleep -Milliseconds 600
    }
  }

  return $false
}

if (-not (Test-Path $cloudflaredPath)) {
  throw "cloudflared_not_found: $cloudflaredPath"
}

Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
Stop-PortOwner $apiPort

Remove-Item $apiLog, $apiErrLog, $tunnelLog, $tunnelErrLog -ErrorAction SilentlyContinue

$apiCommand = '$env:FIAPAUTO_API_PORT="43878"; $env:FIAPAUTO_API_HOST="127.0.0.1"; npm run dev:api'
$apiProcess = Start-Process `
  -FilePath 'powershell.exe' `
  -ArgumentList '-NoLogo', '-NoProfile', '-Command', $apiCommand `
  -WorkingDirectory $repoRoot `
  -RedirectStandardOutput $apiLog `
  -RedirectStandardError $apiErrLog `
  -WindowStyle Hidden `
  -PassThru

if (-not (Wait-ForHttp "http://127.0.0.1:$apiPort/api/public/topics")) {
  Write-Status @{
    startedAt = (Get-Date).ToString('o')
    api = @{
      ok = $false
      port = $apiPort
      processId = $apiProcess.Id
      log = $apiLog
      errLog = $apiErrLog
    }
    tunnel = @{
      ok = $false
    }
  }
  throw "public_api_failed_to_start_on_$apiPort"
}

$tunnelProcess = Start-Process `
  -FilePath $cloudflaredPath `
  -ArgumentList 'tunnel', '--url', "http://127.0.0.1:$apiPort", '--logfile', $tunnelLog `
  -RedirectStandardError $tunnelErrLog `
  -WindowStyle Hidden `
  -PassThru

$tunnelUrl = $null
$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline -and -not $tunnelUrl) {
  if (Test-Path $tunnelLog) {
    $match = Select-String -Path $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches | Select-Object -Last 1
    if ($match -and $match.Matches.Count -gt 0) {
      $tunnelUrl = $match.Matches[$match.Matches.Count - 1].Value
      break
    }
  }

  Start-Sleep -Milliseconds 700
}

$status = @{
  startedAt = (Get-Date).ToString('o')
  api = @{
    ok = $true
    port = $apiPort
    url = "http://127.0.0.1:$apiPort"
    processId = $apiProcess.Id
    log = $apiLog
    errLog = $apiErrLog
  }
  tunnel = @{
    ok = [bool]$tunnelUrl
    url = $tunnelUrl
    processId = $tunnelProcess.Id
    log = $tunnelLog
    errLog = $tunnelErrLog
  }
}

Write-Status $status
$status | ConvertTo-Json -Depth 5

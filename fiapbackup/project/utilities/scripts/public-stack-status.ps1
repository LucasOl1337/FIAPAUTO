$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$statusFile = Join-Path $repoRoot 'backend\runtime\public-stack\status.json'

if (-not (Test-Path $statusFile)) {
  Write-Output 'public_stack_status_not_found'
  exit 1
}

Get-Content $statusFile

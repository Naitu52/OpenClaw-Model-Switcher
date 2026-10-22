# Copy the new dev index.html to the global install, restart the switcher service
# Why: the user is running the global install (port 2325) but the dev has the token modal removed.
# Restart: stop existing switcher process (PID 39472), Start-ScheduledTask or relaunch.

$ErrorActionPreference = 'Stop'

# 路径可用环境变量覆盖：SWITCHER_DEV_DIR / SWITCHER_GLOBAL_DIR
$repoRoot = Split-Path -Parent $PSScriptRoot
$dev  = Join-Path $repoRoot 'index.html'
$glob = if ($env:SWITCHER_GLOBAL_DIR) { Join-Path $env:SWITCHER_GLOBAL_DIR 'index.html' }
         else { Join-Path (npm root -g) 'openclaw-model-switcher\index.html' }

if (-not (Test-Path $dev))  { throw "dev not found: $dev" }
if (-not (Test-Path $glob)) { throw "global not found: $glob" }

# Backup current global (so user can roll back)
$bak = "$glob.pre-6.5.3"
Copy-Item $glob $bak -Force
Write-Host "[bak] $bak  ($((Get-Item $bak).Length)B)"

# Copy dev over
Copy-Item $dev $glob -Force
Write-Host "[copy] $dev -> $glob  ($((Get-Item $glob).Length)B)"

# Restart switcher
$running = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -eq 2325 } | Select-Object -ExpandProperty OwningProcess
Write-Host "[before] switcher PID: $running"

if ($running) {
  $proc = Get-Process -Id $running -ErrorAction SilentlyContinue
  if ($proc) {
    Write-Host "  killing $running ($($proc.ProcessName))"
    Stop-Process -Id $running -Force
    Start-Sleep -Seconds 2
  }
}

# Re-launch via scheduled task (preferred — same env as before)
$st = Get-ScheduledTask -TaskName 'OpenClawModelSwitcher' -ErrorAction SilentlyContinue
if ($st) {
  Write-Host "[start] Start-ScheduledTask OpenClawModelSwitcher"
  Start-ScheduledTask -TaskName 'OpenClawModelSwitcher' | Out-Null
  Start-Sleep -Seconds 3
} else {
  Write-Host "[fallback] no scheduled task, starting switcher directly"
  $exe = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $exe) { $exe = 'C:\Program Files\nodejs\node.exe' }
  $cwd = Split-Path -Parent $glob
  Start-Process -FilePath $exe -ArgumentList 'switcher.cjs' -WorkingDirectory $cwd -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

$after = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -eq 2325 } | Select-Object -ExpandProperty OwningProcess
Write-Host "[after]  switcher PID: $after"

# Verify new bytes are being served
try {
  $r = Invoke-WebRequest -Uri 'http://localhost:2325/' -UseBasicParsing -TimeoutSec 5
  $len = $r.Content.Length
  $hasModal = $r.Content.Contains('showAuthModal') -or $r.Content.Contains('Bearer Token')
  $hasNewComment = $r.Content.Contains('Token modal removed') -or $r.Content.Contains('Token popup')
  Write-Host "[verify] served size: $len  hasOldModal: $hasModal  hasNewComment: $hasNewComment"
} catch {
  Write-Host "[verify] (http probe failed): $($_.Exception.Message)"
}

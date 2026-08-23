# install-task.ps1 — 注册 model-switcher 为开机自启任务（需 admin）
# 用法：右键 PowerShell → 以管理员身份运行 → 执行此脚本
# 或 OpenClaw 主对话里说"安装"由 main agent 代调（它会升 admin 调我）

$ErrorActionPreference = 'Stop'
$taskName = "OpenClawModelSwitcher"
# 日志写到脚本同目录（便携：不硬编码本机路径）
$logPath  = Join-Path $PSScriptRoot "install-result.log"

function Log([string]$m) {
    $line = "$(Get-Date -Format 'HH:mm:ss.fff') $m"
    Add-Content -Path $logPath -Value $line
    Write-Host $m
}

if (Test-Path $logPath) { Remove-Item $logPath -Force }

Log "=== install-task.ps1 START ==="
Log "Current user: $env:USERNAME"
Log "IsAdmin: $([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"

# 清理残留
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Log "Found existing task, removing..."
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false | Out-Null
}

# 重建（便携：node 路径与工作目录均动态解析，不硬编码本机路径）
try {
    $nodeExe = $env:OPENCLAW_NODE
    if (-not $nodeExe -or -not (Test-Path $nodeExe)) {
        $cmd = Get-Command node.exe -ErrorAction Stop
        $nodeExe = $cmd.Source
    }
    $workDir = $PSScriptRoot
    if (-not $workDir) { $workDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

    $action = New-ScheduledTaskAction `
        -Execute $nodeExe `
        -Argument "switcher.cjs" `
        -WorkingDirectory $workDir

    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 5 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew

    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $action `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $settings `
        -Description "OpenClaw Model Switcher v6.5.2 - auto start, auto restart on failure" `
        -Force | Out-Null

    Log "✓ Register-ScheduledTask OK"

    # 立刻跑一次 smoke test（switcher 启动时若 2325 被占会自动 +1，故探测 2325-2330）
    Start-ScheduledTask -TaskName $taskName | Out-Null
    Log "  Started task, waiting 8s..."
    Start-Sleep -Seconds 8

    $r = $null
    foreach ($p in 2325..2330) {
        try {
            $resp = Invoke-WebRequest "http://localhost:$p/api/status" -UseBasicParsing -TimeoutSec 3
            if ($resp.StatusCode -eq 200) { $r = $resp; break }
        } catch { $r = $null }
    }
    if (-not $r) { throw "Switcher not responding on ports 2325-2330" }
    $j = $r.Content | ConvertFrom-Json
    Log "✓ Switcher responding (pid=$($j.pid), uptime=$($j.uptime)s)"
    Log "INSTALL_COMPLETE"
} catch {
    Log "✗ FAILED: $($_.Exception.Message)"
    Log "INSTALL_FAILED"
    exit 1
}

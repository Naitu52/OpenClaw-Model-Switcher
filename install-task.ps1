# install-task.ps1 — 注册 model-switcher 为开机自启任务（需 admin）
# 用法：右键 PowerShell → 以管理员身份运行 → 执行此脚本
# 或 OpenClaw 主对话里说"安装"由 main agent 代调（它会升 admin 调我）

$ErrorActionPreference = 'Stop'
$taskName = "OpenClawModelSwitcher"
$logPath  = "D:\openclaw\workspace\model-switcher\install-result.log"

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

# 重建
try {
    $action = New-ScheduledTaskAction `
        -Execute "C:\Program Files\nodejs\node.exe" `
        -Argument "switcher.cjs" `
        -WorkingDirectory "D:\openclaw\workspace\model-switcher"

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
        -Description "OpenClaw Model Switcher v6.3 - auto start, auto restart on failure" `
        -Force | Out-Null

    Log "✓ Register-ScheduledTask OK"

    # 立刻跑一次 smoke test
    Start-ScheduledTask -TaskName $taskName | Out-Null
    Log "  Started task, waiting 8s..."
    Start-Sleep -Seconds 8

    $r = Invoke-WebRequest "http://localhost:2325/api/status" -UseBasicParsing -TimeoutSec 15
    $j = $r.Content | ConvertFrom-Json
    Log "✓ Switcher responding (pid=$($j.pid), uptime=$($j.uptime)s)"
    Log "INSTALL_COMPLETE"
} catch {
    Log "✗ FAILED: $($_.Exception.Message)"
    Log "INSTALL_FAILED"
    exit 1
}

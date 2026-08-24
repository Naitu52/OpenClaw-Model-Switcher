@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title OpenClaw Model Switcher v6.5.2 (portable)
cd /d "%~dp0"
if not defined SWITCHER_PORT set "SWITCHER_PORT=2325"

color 0B

echo.
echo   Model Switcher v6.5.2 (portable)
echo   ==============================
echo.

echo   [1/3] Cleaning up stale switcher instances...
for /l %%P in (2325,1,2330) do (
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%%P " ^| findstr /I "LISTENING" 2^>nul') do taskkill /F /PID %%p >nul 2>&1
)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'switcher' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>nul
timeout /t 2 /nobreak >nul
echo   [1/3] Done.

echo   [2/3] Starting switcher from: %CD%
echo.
node -e "const o=require('os'^);console.log('    platform:',process.platform,'  home:',o.homedir(^)^);" 2>nul

if defined OPENCLAW_NODE (
    "%OPENCLAW_NODE%" switcher.cjs
) else (
    node switcher.cjs
)

echo   [3/3] Switcher exited (code %errorlevel%).
echo.
if %errorlevel% neq 0 (
    echo   [FAIL] exit code = %errorlevel%
    echo.
    echo   Common causes:
    echo   - Port in use:  set SWITCHER_PORT=2326
    echo   - Node missing: install Node.js or set OPENCLAW_NODE
    echo   - OPENCLAW not found: set OPENCLAW_HOME
    echo.
) else (
    echo   [OK] Switcher started. Open http://localhost:%SWITCHER_PORT%/ in browser.
    echo.
)
echo Press any key to close this window...
pause >nul

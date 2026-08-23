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

node -e "const o=require('os'^);console.log('    platform:',process.platform,'  home:',o.homedir(^)^);" 2>nul

if defined OPENCLAW_NODE (
    "%OPENCLAW_NODE%" switcher.cjs
) else (
    node switcher.cjs
)

if %errorlevel% neq 0 (
    echo.
    echo   [FAIL] exit code = %errorlevel%
    echo.
    echo   Common causes:
    echo   - Port in use:  set SWITCHER_PORT=2326
    echo   - Node missing: install Node.js or set OPENCLAW_NODE
    echo   - OPENCLAW not found: set OPENCLAW_HOME
    echo.
) else (
    echo.
    echo   [OK] Switcher started. Open http://localhost:%SWITCHER_PORT%/ in browser.
    echo.
)
echo Press any key to close this window...
pause >nul
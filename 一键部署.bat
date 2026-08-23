@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title OpenClaw Model Switcher v6.5.2 - Deploy
cd /d "%~dp0"

color 0B

echo.
echo   ==========================================
echo    System Environment Check        (Phase A)
echo   ==========================================
echo.

for /f "tokens=*" %%v in ('ver') do set "OS_VER=%%v"
echo   OS:         %OS_VER%
echo   Arch:       %PROCESSOR_ARCHITECTURE%
echo   User:       %USERNAME%@%USERDOMAIN%
echo   Cwd:        %CD%

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo   Node:       NOT FOUND
    echo.
    echo   [X] Node.js 18+ required.
    echo       Install from https://nodejs.org/ and re-run.
    echo.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node --version') do set "NODE_VER=%%v"
echo   Node:       %NODE_VER%
set "NODE_VER_CLEAN=%NODE_VER:v=%"
for /f "tokens=1 delims=." %%a in ("%NODE_VER_CLEAN%") do set "NODE_MAJOR=%%a"
if not defined NODE_MAJOR set "NODE_MAJOR=0"
if %NODE_MAJOR% lss 18 (
    echo   [X] Node 18+ required ^(current %NODE_VER%^).
    pause
    exit /b 1
)

where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo   npm:        NOT FOUND
    pause
    exit /b 1
)
for /f "delims=" %%v in ('npm --version') do set "NPM_VER=%%v"
echo   npm:        v%NPM_VER%

net session >nul 2>&1
if %errorlevel% equ 0 (
    echo   Admin:      YES
    set "IS_ADMIN=1"
) else (
    echo   Admin:      no
    set "IS_ADMIN=0"
)

echo.
echo   OpenClaw detection (pre-install):
set "HINT_HOME="
set "HINT_CLI="
set "HINT_CFG="
if exist "C:\openclaw\.openclaw\openclaw.json" (set "HINT_HOME=C:\openclaw\.openclaw" & set "HINT_CFG=C:\openclaw\.openclaw\openclaw.json")
if not defined HINT_HOME if exist "%USERPROFILE%\.openclaw\openclaw.json" (set "HINT_HOME=%USERPROFILE%\.openclaw" & set "HINT_CFG=%USERPROFILE%\.openclaw\openclaw.json")
if not defined HINT_HOME if exist "%LOCALAPPDATA%\openclaw\openclaw.json" (set "HINT_HOME=%LOCALAPPDATA%\openclaw" & set "HINT_CFG=%LOCALAPPDATA%\openclaw\openclaw.json")
if not defined HINT_HOME (
    echo     home:      NOT detected
) else (
    echo     home:      !HINT_HOME!
)
if not defined HINT_CFG (
    echo     config:    NOT detected
) else (
    echo     config:    !HINT_CFG!
)
where openclaw >nul 2>&1
if not errorlevel 1 (
    for /f "delims=" %%c in ('where openclaw') do (
        if "!HINT_CLI!"=="" set "HINT_CLI=%%c"
    )
    echo     cli:       !HINT_CLI!
) else (
    echo     cli:       NOT in PATH
)

echo.
echo   Port 2324-2330 occupancy check:    (Phase B)
for /l %%p in (2324,1,2330) do (
    set "PORTPROC=free"
    for /f "tokens=5" %%q in ('netstat -ano ^| findstr /R /C:":%%p " 2^>nul') do (
        if "!PORTPROC!"=="free" set "PORTPROC=in-use PID=%%q"
    )
    if "!PORTPROC!"=="free" (
        echo     :%%p   free
    ) else (
        echo     :%%p   IN USE  ^(!PORTPROC!^)
    )
)

echo.
echo   ==========================================
echo    Existing Installation Check     (Phase E)
echo   ==========================================
set "EXISTING_NONE=1"
where openclaw-switcher >nul 2>&1
if not errorlevel 1 (
    echo   Detected openclaw-switcher on PATH:
    where openclaw-switcher
    set "EXISTING_NONE=0"
)
call npm ls -g --depth=0 openclaw-model-switcher >nul 2>&1
if not errorlevel 1 (
    echo   Detected global install:
    call npm ls -g --depth=0 openclaw-model-switcher
    set "EXISTING_NONE=0"
)
if "%EXISTING_NONE%"=="1" (
    echo   No prior install found.
) else (
    echo.
    set /p CONFIRM="   Replace existing install? [y/N]: "
    if /i not "!CONFIRM!"=="y" (
        echo   Skipped. Existing install kept.
        pause
        exit /b 0
    )
)

echo.
echo   ==========================================
echo    Choose Install Mode
echo   ==========================================
echo     [1] Global  ^(npm install -g, recommended, needs admin^)
echo     [2] Local   ^(no admin, runs via npx^)
echo     [3] Custom prefix  ^(specify install path^)
echo.
set /p MODE="   Choose 1, 2, or 3 [default 1]: "
if "!MODE!"=="" set "MODE=1"
if "!MODE!"=="3" (
    set /p PREFIX="   Enter prefix path: "
)

echo.
echo   ==========================================
echo    Locate .tgz
echo   ==========================================
set "PKG="
for %%f in (openclaw-model-switcher-*.tgz) do set "PKG=%%~ff"
if "!PKG!"=="" (
    echo   No .tgz - auto-packing...
    call npm pack 2>nul || goto :pack_failed
    for %%f in (openclaw-model-switcher-*.tgz) do set "PKG=%%~ff"
    if "!PKG!"=="" goto :pack_failed
    echo   ✓ Auto-generated: !PKG!
) else (
    echo   ✓ Package: !PKG!  ^(newest .tgz in directory^)
)

echo.
echo   ==========================================
echo    Installing
echo   ==========================================
if "!MODE!"=="1" (
    echo   Mode: global
    call npm install -g "!PKG!" || (
        echo   Global failed - falling back to local...
        call npm install "!PKG!" || goto :install_failed
    )
) else if "!MODE!"=="2" (
    call npm install "!PKG!" || goto :install_failed
) else (
    echo   Mode: custom prefix=!PREFIX!
    call npm install --prefix="!PREFIX!" "!PKG!" || goto :install_failed
)

echo.
echo   ==========================================
echo    Post-Install Summary        (Phase C)
echo   ==========================================
echo   Mode:        !MODE!
for /f "delims=" %%v in ('node -e "console.log(require('openclaw-model-switcher/package.json'^).version)" 2^>nul') do set "INSTALLED_VER=%%v"
if "!INSTALLED_VER!"=="" set "INSTALLED_VER=6.5.2"
echo   Version:     !INSTALLED_VER!

echo.
echo   Smoke test:
call node test\smoke.js
if not "!errorlevel!"=="0" (
    echo     [!] Test issues - check output above
) else (
    echo     ^>^> Smoke tests passed
)

echo.
echo   Binary:
if "!MODE!"=="1" (
    where openclaw-switcher 2>nul
) else if "!MODE!"=="2" (
    echo     !CD!\node_modules\.bin\openclaw-switcher.cmd
) else (
    echo     !PREFIX!\node_modules\.bin\openclaw-switcher.cmd
)

echo.
echo   Default state paths (override via SWITCHER_* env):
echo     Windows: %LOCALAPPDATA%\OpenClawModelSwitcher\
echo     Linux/Mac: ^~/.openclaw-model-switcher/

echo.
echo   Quick start:
echo     openclaw-switcher          ^(listens on 2325^)
echo     set SWITCHER_PORT=2400 ^& openclaw-switcher
echo     Web UI: http://localhost:2325/
echo.
echo   ==========================================
echo    DEPLOY COMPLETE
echo   ==========================================
echo.
echo Press any key to LAUNCH now ^(Ctrl+C to skip^)^...
pause >nul
call openclaw-switcher 2>nul
if errorlevel 1 call npx openclaw-switcher 2>nul
echo.
echo Server stopped. Re-run anytime.
pause
exit /b 0

:pack_failed
echo   [X] npm pack failed.
pause
exit /b 1

:install_failed
echo   [X] Install failed. Try Run as Administrator.
pause
exit /b 1
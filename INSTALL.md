# OpenClaw Model Switcher - Quick Install

## One-click (Windows)

Double-click `一键部署.bat`:

1. Shows system environment (OS/Node/npm/admin/OpenClaw/ports/existing install)
2. Asks for install mode (global/local/custom prefix)
3. Locates or builds .tgz
4. Installs
5. Runs smoke test (6/6)
6. Prints post-install summary
7. Press any key to launch

If global install fails: right-click the bat and "Run as Administrator".

## Manual install (any platform)

Requires Node.js 18+ (already required by OpenClaw itself).

    # From local tarball
    npm install -g ./openclaw-model-switcher-6.1.0.tgz
    openclaw-switcher                # listens on 2325

    # Or unzip and run
    tar xzf openclaw-model-switcher-6.1.0.tgz
    cd package/
    node switcher.cjs

Custom port / config:

    SWITCHER_PORT=2400 \
    OPENCLAW_HOME=/path/to/.openclaw \
    node switcher.cjs

State paths (defaults; override via env vars):
    SWITCHER_LOG        full path to log file
    SWITCHER_BACKUP_DIR full path to backup directory (recommended: persistent per-machine)
    SWITCHER_SCENES     full path to scenes.json file

On Windows, defaults land in: %LOCALAPPDATA%\OpenClawModelSwitcher\
On Linux/Mac:                  ~/.openclaw-model-switcher/

## Auto-start (Windows)

For boot-time / logon auto-start with restart-on-failure:

1. Right-click `install-task.ps1` -> "Run with PowerShell" (admin)
2. Click Yes on UAC
3. Done -- switcher runs every time you log in

## What is this?

A web UI for managing OpenClaw agents, models, providers, and Feishu bot
bindings. Reads/writes `openclaw.json` directly. Portable across Linux/macOS/
Windows and any machine layout -- auto-detects paths via 5-strategy fallback
(env var -> platform-known -> npm-global -> which/where -> bounded parent scan).

Full docs: see `README.md` in this directory.
Smoke test:  `npm test`
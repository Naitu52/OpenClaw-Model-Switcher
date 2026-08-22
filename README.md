# OpenClaw Model Switcher v6 — Portable Edition

A self-contained Node.js web UI to manage OpenClaw agents, models, providers,
and Feishu bot bindings. Reads/writes `openclaw.json` directly via atomic
rename + backups.

## Quick start (this machine, defaults)

    cd D:\openclaw\workspace\model-switcher
    node switcher.cjs
    # or double-click 启动Switcher.bat
    # Open http://localhost:2325/ in browser

The defaults assume the original Windows layout:

    OPENCLAW_HOME  =  D:\openclaw\.openclaw
    OPENCLAW_WS    =  D:\openclaw\workspace
    OPENCLAW_CLI   =  D:\nodejs\node_global\node_modules\openclaw\openclaw.mjs
    PORT           =  2325

## Run on any other machine

Set any subset of these env vars to override auto-detection:

| Var | What | Example |
|-----|------|---------|
| `OPENCLAW_HOME`   | path to `.openclaw` dir                       | `C:\Users\me\.openclaw` |
| `OPENCLAW_WS`     | path to workspace dir                          | `D:\work\workspace`     |
| `OPENCLAW_AGENTS` | path to agents dir                            | `C:\...\agents`         |
| `OPENCLAW_CLI`    | path to `openclaw.mjs` or `dist/index.js`    | `C:\…\npm\node_modules\openclaw\openclaw.mjs` |
| `FEISHU_REG`      | path to `app-registration-*.js`              | auto-detected from CLI  |
| `OPENCLAW_NODE`   | node binary (default: `node` on PATH)        | `D:\nodejs\node.exe`    |
| `SWITCHER_PORT`   | TCP port (default `2325`)                     | `2400`                  |

Examples (PowerShell):

    $env:OPENCLAW_HOME = "$HOME\.openclaw"
    $env:OPENCLAW_CLI  = "$env:APPDATA\npm\node_modules\openclaw\openclaw.mjs"
    $env:SWITCHER_PORT = 2400
    node switcher.cjs

Examples (bash):

    OPENCLAW_HOME=$HOME/.openclaw \
    OPENCLAW_CLI=/usr/local/lib/node_modules/openclaw/openclaw.mjs \
    SWITCHER_PORT=2400 \
    node switcher.cjs

## Auto-detection order per slot

1. Explicit env var (only used if `openclaw.json` exists inside it)
2. Machine-known Windows convention (`D:\openclaw\...`)
3. OS default (Linux/macOS: `~/.openclaw`, `/opt/openclaw`, etc.)
4. CWD-relative fallback

**Graceful degrade**: if `OPENCLAW_CLI` is missing, /api/models returns
`{error: 'CLI not configured', hint: 'set OPENCLAW_CLI env var'}`.
Feishu register endpoints require both CLI and FEISHU_REG; if missing they
return 503. Everything else (agents, providers, backups, file editor)
works without the CLI.

## Model registry sync (v6.3+)

`agents.defaults.models` is a registry of every model the user has ever
referenced. Without explicit cleanup, deleting a GGUF from disk (or
removing it from a provider's `models` list) leaves orphan keys behind.
The switcher reconciles in two ways:

1. **Real-time on probe** — `POST /api/probe` now also prunes any
   `${provider}/X` key from `agents.defaults.models` where `X` is no
   longer in the freshly-probed list, AND no agent currently uses it as
   `model.primary`. So every successful probe is a live sync.
2. **Manual cleanup** — `POST /api/agents/defaults/models/prune` (or
   `GET ...?dryRun=true` for a safe preview) does a global pass using
   each provider's current `models` list as ground truth. Removes any
   key that is (a) not in use by any agent, AND (b) not present in any
   `models.providers[*].models[*].id`. In-use keys (e.g. remote-only
   models registered outside the switcher) are always preserved.

In-use keys are always preserved, so an orphan can never break a live
agent assignment. After prune, `agents.defaults.models` only contains
models that are still real, still assigned, or both.

## Diagnostic

    GET /api/status     # uptime, agent count, paths block
    GET /api/paths      # all resolved paths as JSON (planned, falls back if not implemented)

The bootstrap log prints the resolved paths:

    [paths] home=D:\openclaw\.openclaw
    [paths] ws=D:\openclaw\workspace
    [paths] agents=D:\openclaw\.openclaw\agents
    [paths] cli=D:\nodejs\node_global\node_modules\openclaw\openclaw.mjs
    [paths] feishu_reg=D:\nodejs\node_global\node_modules\openclaw\dist\app-registration-D-oqMP2f.js
    [paths] port=2399
    [Server: http://localhost:2399 (pid=N)]

## Files in this directory

| File | Purpose |
|------|---------|
| `switcher.cjs`          | Node.js server (portable) |
| `switcher.cjs.v1-original` | Pre-portable version, kept for rollback |
| `index.html`            | Single-page frontend |
| `启动Switcher.bat`        | Windows launcher (env vars documented inline) |
| `启动Switcher.bat.legacy`  | Old launcher (pre-portable .bat) |
| `install-task.ps1`       | Registers this as a Windows scheduled task |
| `scenes.json`           | Your saved scene presets |
| `backups/`              | Rolling 30 backups of `openclaw.json` |
| `switcher.log`          | Boot + change log |

## Endpoints

Common (works without CLI):

    GET  /api/status
    GET  /api/agents
    GET  /api/providers
    GET  /api/providers/catalog
    GET  /api/backups
    GET  /api/scenes
    GET  /api/log
    GET  /api/feishu                     # account/binding config
    GET  /api/feishu/diagnostics
    POST /api/switch                      # {changes: {agentId: modelId}}
    POST /api/probe                       # {provider, apiKey, baseUrl?}
    GET  /api/agents/defaults/models/prune?dryRun=true   # safe dry-run (always read-only)
    POST /api/agents/defaults/models/prune               # real cleanup; respects ?dryRun=true or body.dryRun
    POST /api/rollback                    # {path: '<backup path>'}
    POST /api/agent/create                # {id, workspaceTemplate, [appId, appSecret]}
    POST /api/agent/delete                # {id}
    GET  /api/agent/:id/files
    GET  /api/agent/:id/file?path=...
    POST /api/agent/:id/file/write        # {path, content}
    POST /api/scenes/save | apply | delete
    POST /api/feishu/bot/save | delete
    POST /api/feishu/binding/save | delete
    POST /api/feishu/allowfrom/add | remove

CLI-required (return 503 when CLI missing):

    GET  /api/models?q=...
    POST /api/feishu/register/begin | poll | save    # QR sign-up flow

## Auto-start on Windows login

Run `install-task.ps1` once with admin via the OpenClaw scheduled task
(`START IN ADMIN POWERSHELL`, run `D:\openclaw\workspace\model-switcher\install-task.ps1`,
then click Yes on the UAC prompt). It registers `OpenClawModelSwitcher`
to start on user logon with auto-restart on failure.

## Multi-instance on one machine

Two switcher instances on the same host: use different ports and point
each instance's `SWITCHER_LOG`, `SWITCHER_BACKUP_DIR`, `SWITCHER_SCENES`,
`OPENCLAW_HOME` at independent paths — otherwise backups will clobber each
other.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Browser can't connect; switcher.log shows `Port N in use` | Another instance on that port | set `SWITCHER_PORT=2326` (any free port) |
| `/api/status` → `Config read failed` | `OPENCLAW_HOME` points wrong or has no `openclaw.json` | leave env unset, re-check boot log for `home=...` |
| `/api/models` → 503 `CLI not configured` | `OPENCLAW_CLI` not set & auto-detect failed | `set OPENCLAW_CLI=C:\path\to\openclaw.mjs` |
| `/api/feishu/register/*` → 503 | `FEISHU_REG` not found (Feishu SDK missing) | install OpenClaw with feishu integration, or skip |
| Black window flashes & exits | `node` not on PATH or `.bat` runs in wrong CWD | install Node, or `set OPENCLAW_NODE=C:\nodejs\node.exe` |
| Port 2324 fails (Windows only) | Windows HTTP.SYS reserves it | use 2325+ (default already 2325) |
| Stale cached config after big edits | auto-rename is atomic, but if interrupted | `GET /api/log` to confirm write completed, retry once |
| Multiple switchers in same dir overwrite each other's backups | both writing to `<dir>/backups` | `set SWITCHER_BACKUP_DIR=...` to per-instance path |
| Boot takes >5s | npm / parent-dir deep scan running | expected trade-off; check `[paths]` log line to see which stage found it |
| Windows .bat shows garbled `not a command` lines | file encoded UTF-8 without BOM, run via cmd | bat includes `chcp 65001 >nul`; if still garbled, run via `node switcher.cjs` directly |

## Smoke test

A `test/smoke.js` script exercises core endpoints with a temporary
isolated instance. Run with `node test/smoke.js`. Exits 0 on success,
1 on any failure.

    node test/smoke.js

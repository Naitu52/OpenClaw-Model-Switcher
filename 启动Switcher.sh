#!/usr/bin/env bash
# OpenClaw Model Switcher v6.5.2 - portable launcher (macOS / Linux)
#
# Usage:
#   ./启动Switcher.sh                              # default port 2325
#   SWITCHER_PORT=2400 ./启动Switcher.sh           # custom port
#   OPENCLAW_HOME=/path/to/.openclaw ./启动Switcher.sh
#
# Env vars (all optional, override auto-detection):
#   OPENCLAW_HOME, OPENCLAW_WS, OPENCLAW_AGENTS, OPENCLAW_CLI, FEISHU_REG
#   SWITCHER_PORT, SWITCHER_LOG, SWITCHER_BACKUP_DIR, SWITCHER_SCENES

set -e
cd "$(dirname "$0")"

echo
echo "  Model Switcher v6.5.2 (portable)"
echo "  =============================="
echo

# --- Node check (OPENCLAW_NODE overrides PATH lookup) ---
NODE_BIN="${OPENCLAW_NODE:-node}"
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
    echo "  [X] Node.js 18+ required. Install from https://nodejs.org/ or set OPENCLAW_NODE."
    echo
    read -rp "  Press any key to close..."
    exit 1
fi

NODE_VER=$("$NODE_BIN" --version)
NODE_MAJOR=${NODE_VER#v}
NODE_MAJOR=${NODE_MAJOR%%.*}
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo "  [X] Node 18+ required (current $NODE_VER)."
    echo
    read -rp "  Press any key to close..."
    exit 1
fi
echo "  Node:       $NODE_VER"
echo "  Cwd:        $(pwd)"
echo "  OPENCLAW_HOME: ${OPENCLAW_HOME:-<auto>}"
echo "  SWITCHER_PORT: ${SWITCHER_PORT:-2325}"
echo

# --- Launch ---
"$NODE_BIN" switcher.cjs
RC=$?

if [ $RC -ne 0 ]; then
    echo
    echo "  [FAIL] exit code = $RC"
    echo
    echo "  Common causes:"
    echo "  - Port in use:   SWITCHER_PORT=2326 $0"
    echo "  - Node missing:  install Node.js 18+"
    echo "  - OPENCLAW_HOME not set: export OPENCLAW_HOME=/path/to/.openclaw"
    echo
    read -rp "  Press any key to close..."
    exit $RC
else
    echo
    echo "  [OK] Switcher started. Open http://localhost:${SWITCHER_PORT:-2325}/ in browser."
    echo
    read -rp "  Press any key to close..."
fi

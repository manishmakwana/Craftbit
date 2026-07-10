#!/usr/bin/env bash
# Runs on every Codespace start (devcontainer postStartCommand). Restarts the
# Vite dev server in the background so re-opening the Codespace doesn't leave
# a stale/duplicate process from a previous session.
set -euo pipefail

pkill -f "vite" 2>/dev/null || true

cd "$(dirname "$0")/.."
nohup pnpm --filter @craftbit/app dev > /tmp/craftbit-dev.log 2>&1 &
disown

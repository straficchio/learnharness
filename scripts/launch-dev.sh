#!/usr/bin/env bash
# Launch LearnHarness from this working clone (development shell).
#
# Used by ~/.local/share/applications/learnharness.desktop. Keeps one
# instance per user, writes logs under ~/.cache/learnharness, and starts
# both the loopback Next server and the Electron shell through the
# repository's `desktop:dev` script.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${XDG_CACHE_HOME:-$HOME/.cache}/learnharness"
LOG="$STATE/desktop.log"
LOCK="$STATE/desktop.lock"

mkdir -p "$STATE"

# The desktop session may not inherit mise's shell initialization. Prefer
# the shell's npm; fall back to this machine's mise Node install.
if ! command -v npm >/dev/null 2>&1; then
  export PATH="/home/marco/.local/share/mise/installs/node/26.8.2/bin:$PATH"
fi

# One launcher instance per user. Keep fd 9 open for the life of the app so
# closing the window releases the lock and the next click starts fresh.
exec 9>"$LOCK"
if ! flock -n 9; then
  notify-send -a LearnHarness "LearnHarness is already running" 2>/dev/null || true
  exit 0
fi

cd "$ROOT"
{
  printf '\n[%s] launching LearnHarness from %s\n' "$(date -Is)" "$ROOT"
} >>"$LOG"

exec npm run desktop:dev >>"$LOG" 2>&1

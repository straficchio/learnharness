#!/usr/bin/env bash
# Development desktop launch: start Next dev, WAIT for it to answer, then
# open the Electron shell. The old `concurrently` pair raced Electron against
# the dev server's first compile: Electron loaded too early, got
# ERR_CONNECTION_REFUSED, and the -k concurrently run tore everything down
# (the user-visible black window).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${LH_DEV_PORT:-3000}"
URL="http://127.0.0.1:${PORT}"
NEXT_PID=""
ELECTRON_PID=""

cleanup() {
  if [[ -n "${ELECTRON_PID}" ]]; then kill "${ELECTRON_PID}" 2>/dev/null || true; fi
  if [[ -n "${NEXT_PID}" ]]; then kill "${NEXT_PID}" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

cd "$ROOT"

server_ready() {
  curl -fsS --max-time 3 "$URL/api/settings" 2>/dev/null | grep -q '"settings"'
}

port_in_use() {
  ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN
}

if server_ready; then
  echo "[desktop-dev] using the dev server already listening at $URL"
else
  if port_in_use; then
    # The port may belong to a dev server that is still compiling /api/settings.
    # Never start a second Next process just because the first health probe lost
    # a race: wait for the existing LearnHarness server instead.
    echo "[desktop-dev] port $PORT is in use; waiting for LearnHarness to answer"
    ready=0
    for _ in $(seq 1 240); do
      if server_ready; then
        ready=1
        break
      fi
      sleep 0.5
    done
    if [[ "$ready" != "1" ]]; then
      echo "[desktop-dev] port $PORT is in use but LearnHarness did not answer"
      exit 1
    fi
  else
    echo "[desktop-dev] starting Next dev at $URL"
    ./node_modules/.bin/next dev -H 127.0.0.1 -p "$PORT" &
    NEXT_PID=$!

    ready=0
    for _ in $(seq 1 240); do
      if ! kill -0 "$NEXT_PID" 2>/dev/null; then
        echo "[desktop-dev] Next dev exited before becoming ready"
        exit 1
      fi
      if server_ready; then
        ready=1
        break
      fi
      sleep 0.5
    done
    if [[ "$ready" != "1" ]]; then
      echo "[desktop-dev] Next dev did not answer within 120 seconds"
      exit 1
    fi
  fi
fi

echo "[desktop-dev] server ready — opening LearnHarness"
LH_DEV_URL="$URL" ./node_modules/.bin/electron . &
ELECTRON_PID=$!

if [[ -n "$NEXT_PID" ]]; then
  # Whichever side exits first, the trap closes the other.
  wait -n "$NEXT_PID" "$ELECTRON_PID" || true
else
  wait "$ELECTRON_PID" || true
fi

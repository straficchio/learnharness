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

if curl -fsS --max-time 1 "$URL/" >/dev/null 2>&1; then
  echo "[desktop-dev] using the dev server already listening at $URL"
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
    if curl -fsS --max-time 1 "$URL/" >/dev/null 2>&1; then
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

echo "[desktop-dev] server ready — opening LearnHarness"
LH_DEV_URL="$URL" ./node_modules/.bin/electron . &
ELECTRON_PID=$!

if [[ -n "$NEXT_PID" ]]; then
  # Whichever side exits first, the trap closes the other.
  wait -n "$NEXT_PID" "$ELECTRON_PID" || true
else
  wait "$ELECTRON_PID" || true
fi

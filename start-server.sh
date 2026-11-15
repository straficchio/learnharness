#!/usr/bin/env bash
# Linux launcher for the headless multi-user server.
# Install/build/start logic lives in scripts/launch-server.mjs.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
if ! command -v node >/dev/null 2>&1; then
	echo "Node.js 22 or newer is required: https://nodejs.org/" >&2
	exit 1
fi
exec node scripts/launch-server.mjs "$@"

#!/usr/bin/env bash
# macOS launcher for the headless multi-user server.
# Double-click this file in Finder, or run it from Terminal.
# Install/build/start logic lives in scripts/launch-server.mjs.
set -uo pipefail
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
	echo "Node.js 22 or newer is required: https://nodejs.org/"
	echo
	read -r -n 1 -s -p "Press any key to close this window..."
	echo
	exit 1
fi
node scripts/launch-server.mjs "$@"
status=$?
if [ "$status" -ne 0 ]; then
	echo
	read -r -n 1 -s -p "Press any key to close this window..."
	echo
fi
exit "$status"

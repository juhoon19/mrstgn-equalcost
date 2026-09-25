#!/usr/bin/env bash
# Starts the local cluster in the background (used by tests/benchmarks).
# Usage: scripts/dev-bg.sh [launch args...]; stop with scripts/dev-stop.sh
cd "$(dirname "$0")/.."
mkdir -p .run
node src/launch.js "$@" > .run/launch.log 2>&1 &
echo $! > .run/launch.pid

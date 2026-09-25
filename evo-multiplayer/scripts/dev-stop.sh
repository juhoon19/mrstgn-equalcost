#!/usr/bin/env bash
cd "$(dirname "$0")/.."
[ -f .run/launch.pid ] && kill "$(cat .run/launch.pid)" 2>/dev/null
rm -f .run/launch.pid

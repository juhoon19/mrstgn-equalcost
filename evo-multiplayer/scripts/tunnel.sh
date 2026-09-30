#!/usr/bin/env bash
# Put a server running on THIS computer on the public internet in one
# command, without a domain, port forwarding or a public IP.
#
#   ./scripts/tunnel.sh            # starts the game on :8080 and a tunnel
#   PORT=9000 ./scripts/tunnel.sh
#
# Uses a Cloudflare "quick tunnel" (https://<random>.trycloudflare.com).
# Limits: no uptime guarantee and ~200 concurrent requests - every open
# WebSocket counts - so it suits playtests with friends. For more players
# create a named tunnel on a free Cloudflare account (no such cap) or
# deploy to a VPS (docs/deploy.md).
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8080}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found. Install it first:"
  echo "  macOS:   brew install cloudflared"
  echo "  Windows: winget install --id Cloudflare.cloudflared"
  echo "  Linux:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi

[ -d node_modules ] || npm install --omit=dev

# Behind the tunnel every player arrives from the same local address, so the
# per-IP cap must trust X-Forwarded-For from cloudflared.
# cloudflared sets CF-Connecting-IP to the real visitor address (overwriting
# anything the visitor sent), so that is the header to trust here.
TRUST_PROXY=true IP_HEADER=cf-connecting-ip PORT="$PORT" node src/launch.js "$@" &
GAME_PID=$!
trap 'kill $GAME_PID 2>/dev/null' EXIT
sleep 2
echo
echo ">>> The public URL is printed below (https://....trycloudflare.com). Share it."
echo
cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT"

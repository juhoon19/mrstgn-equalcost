#!/usr/bin/env bash
# Distributed load test: run bench/bots.js on many machines at once.
#
#   HOSTS="10.0.1.11 10.0.1.12 ..." TARGET=wss://soup.example.com/ws \
#   PER_HOST=4 BOTS=400 DURATION=600 ./scripts/bots-fleet.sh
#
# Each host needs Node >= 20 and this repo checked out at $REMOTE_DIR with
# `npm install` done. PER_HOST processes x BOTS bots each run per host
# (one process per core; ~400 bots per process is comfortable).
# Results land in ./.run/fleet/<host>-<n>.log; the summary at the end adds
# them up. Raise file-descriptor and port limits on the bot hosts first
# (see docs/scale-100k.md, "Kernel and OS limits").
set -euo pipefail
: "${HOSTS:?space-separated host list}"
: "${TARGET:?ws(s)://.../ws to test}"
PER_HOST="${PER_HOST:-4}"
BOTS="${BOTS:-400}"
DURATION="${DURATION:-300}"
REMOTE_DIR="${REMOTE_DIR:-evo-multiplayer}"
EXTRA="${EXTRA:---decode 0.01 --act 0.2 --lo 0.3}"
mkdir -p .run/fleet
for h in $HOSTS; do
  for n in $(seq 1 "$PER_HOST"); do
    ssh -o BatchMode=yes "$h" "cd $REMOTE_DIR && ulimit -n 65535 && node bench/bots.js --url $TARGET --n $BOTS --ramp 50 --duration $DURATION --quiet true $EXTRA" \
      > ".run/fleet/$h-$n.log" 2>&1 &
  done
done
echo "started $(( $(echo "$HOSTS" | wc -w) * PER_HOST * BOTS )) bots on $(echo "$HOSTS" | wc -w) host(s); waiting ${DURATION}s..."
wait
python3 - <<'PY'
import glob, json
tot = {}
for f in glob.glob('.run/fleet/*.log'):
    for line in open(f):
        if line.startswith('[bots] result '):
            r = json.loads(line[len('[bots] result '):])
            for k, v in r.items():
                if isinstance(v, (int, float)):
                    tot[k] = tot.get(k, 0) + v
n = max(1, sum(1 for _ in glob.glob('.run/fleet/*.log')))
print('fleet total:', json.dumps(tot))
print('avg bytes/bot/s:', round(tot.get('bytesPerBotPerSec', 0) / n))
PY

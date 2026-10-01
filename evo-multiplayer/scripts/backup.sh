#!/usr/bin/env bash
# Backs up everything that cannot be regenerated: player accounts and
# property (database), the world (shard snapshots) and the secrets that make
# them usable (token secret = player identities, world id = item keys).
#
#   scripts/backup.sh local   [DATA_DIR]       # npm start / launch.js (SQLite)
#   scripts/backup.sh compose [COMPOSE_DIR]    # deploy/docker-compose.yml (PostgreSQL)
#
# Env: BACKUP_DIR (default ./backups), KEEP (how many to keep, default 14),
#      BACKUP_UPLOAD (optional command run with the archive path appended,
#      e.g. "rclone copy" or "aws s3 cp --sse" + destination - keep a copy OFF this machine).
# Safe to run while the game is live. Schedule it, e.g. cron:
#   17 * * * *  cd /srv/evo-multiplayer && scripts/backup.sh compose deploy >> backups/backup.log 2>&1
#
# Restore: see docs/deploy.md ("备份与恢复").

set -euo pipefail
mode=${1:-local}
here=$(cd "$(dirname "$0")/.." && pwd)
out=${BACKUP_DIR:-$here/backups}
keep=${KEEP:-14}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$out" "$work/evo-backup-$stamp"
dst="$work/evo-backup-$stamp"

case "$mode" in
  local)
    data=${2:-$here/data}
    [ -d "$data" ] || { echo "no data dir $data" >&2; exit 1; }
    # Consistent copy of a live SQLite database (VACUUM INTO takes a snapshot).
    if [ -f "$data/meta.db" ]; then
      node --no-warnings -e '
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(process.argv[1]);
        db.exec("PRAGMA busy_timeout=10000");
        db.prepare("VACUUM INTO ?").run(process.argv[2]);
        db.close();' "$data/meta.db" "$dst/meta.db"
    fi
    cp "$data"/shard-*.bin "$dst/" 2>/dev/null || true
    cp "$data"/bans.json "$dst/" 2>/dev/null || true
    cp "$data"/secrets.json "$dst/" 2>/dev/null || true
    ;;
  compose)
    dir=${2:-$here/deploy}
    project=${COMPOSE_PROJECT:-}
    dc() { (cd "$dir" && docker compose ${project:+-p "$project"} "$@"); }
    # Logical dump, consistent at one point in time, restorable on any Postgres >= 16.
    dc exec -T postgres pg_dump -U evo -Fc evo > "$dst/postgres.dump"
    # Every shard volume (snapshots + control-plane bans).
    for svc in $(dc ps --services | grep '^shard'); do
      mkdir -p "$dst/$svc"
      dc cp "$svc:/data/." "$dst/$svc/" >/dev/null 2>&1
    done
    echo "secrets (CLUSTER_SECRET, TOKEN_SECRET, WORLD_ID, ADMIN_TOKEN, POSTGRES_PASSWORD) live in your environment / .env: back them up separately" > "$dst/README.txt"
    ;;
  *)
    echo "usage: $0 local [DATA_DIR] | compose [COMPOSE_DIR]" >&2
    exit 2
    ;;
esac

archive="$out/evo-backup-$stamp.tar.gz"
tar -C "$work" -czf "$archive.part" "evo-backup-$stamp"
mv "$archive.part" "$archive"
chmod 600 "$archive" # contains password hashes and secrets
echo "backup: $archive ($(du -h "$archive" | cut -f1))"

if [ -n "${BACKUP_UPLOAD:-}" ]; then
  $BACKUP_UPLOAD "$archive"
  echo "uploaded with: $BACKUP_UPLOAD"
fi

# Rotation: keep the newest $keep archives.
ls -1t "$out"/evo-backup-*.tar.gz 2>/dev/null | tail -n +"$((keep + 1))" | xargs -r rm -f

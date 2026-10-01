#!/usr/bin/env bash
# Restores an archive made by scripts/backup.sh.
#
#   scripts/restore.sh local   ARCHIVE [DATA_DIR]      # stop the game first
#   scripts/restore.sh compose ARCHIVE [COMPOSE_DIR]   # stops game services, keeps postgres
#
# Compose: start from the same environment (secrets, WORLD_ID) as the backed
# up cluster. The database is replaced by the dump; shard volumes are
# overwritten by the backed up snapshots.

set -euo pipefail
mode=${1:-}
archive=${2:-}
[ -f "$archive" ] || { echo "usage: $0 local|compose ARCHIVE [DIR]" >&2; exit 2; }
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar -C "$work" -xzf "$archive"
src=$(echo "$work"/evo-backup-*)

case "$mode" in
  local)
    data=${3:-$here/data}
    mkdir -p "$data"
    rm -f "$data"/meta.db "$data"/meta.db-wal "$data"/meta.db-shm
    cp "$src"/* "$data"/
    echo "restored into $data"
    ;;
  compose)
    dir=${3:-$here/deploy}
    project=${COMPOSE_PROJECT:-}
    dc() { (cd "$dir" && docker compose ${project:+-p "$project"} "$@"); }
    # Everything but the database stops so nothing writes during the restore.
    services=$(dc config --services | grep -v '^postgres$')
    dc stop $services >/dev/null 2>&1 || true
    dc up -d --wait postgres
    dc exec -T postgres pg_restore -U evo -d evo --clean --if-exists --no-owner < "$src/postgres.dump"
    for d in "$src"/shard*/; do
      svc=$(basename "$d")
      dc create "$svc" >/dev/null 2>&1 || true
      dc cp "$d." "$svc:/data/" >/dev/null 2>&1
    done
    dc up -d $services
    echo "restored; services starting"
    ;;
  *)
    echo "usage: $0 local|compose ARCHIVE [DIR]" >&2
    exit 2
    ;;
esac

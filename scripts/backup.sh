#!/usr/bin/env bash
#
# Backup the LocaPeer Relay database.
#
# Uses better-sqlite3's online backup API inside the running relay container
# and pipes the result straight to the host - no intermediate files in the
# volume, and safe to run while the relay is up (WAL mode makes the backup
# consistent).
#
# Usage:  ./scripts/backup.sh
# Env:    BACKUP_DIR  where backups go (default: ./backups)
#         KEEP        number of backups to retain (default: 7)
#
# Restore steps are in the README (Maintenance section).

set -euo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP="${KEEP:-7}"
TS="$(date +%Y%m%d-%H%M%S)"
DEST="${BACKUP_DIR}/relay-${TS}.db"

mkdir -p "$BACKUP_DIR"

if [ -z "$(docker compose ps --status running -q relay 2>/dev/null)" ]; then
  echo "error: the relay service is not running (run this from the project directory)" >&2
  exit 1
fi

docker compose exec -T relay node -e '
  const fs = require("fs");
  const db = require("better-sqlite3")("/data/relay.db", { readonly: true });
  const out = fs.createWriteStream("/dev/stdout");
  out.on("error", (err) => { console.error(err); process.exit(1); });
  db.backup(out)
    .then(() => { db.close(); out.end(() => process.exit(0)); })
    .catch((err) => { console.error(err); process.exit(1); });
' > "$DEST"

echo "backup written to $DEST ($(du -h "$DEST" | cut -f1))"

# Prune old backups, keeping the newest $KEEP.
ls -1t "${BACKUP_DIR}"/relay-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

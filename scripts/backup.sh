#!/bin/bash
# NEXUS — backup do banco de conversas (SQLite WAL-safe via VACUUM INTO)
set -euo pipefail

BASE="$HOME/.opencode/nexus"
BACKUP_DIR="$BASE/backups"
KEEP=7

mkdir -p "$BACKUP_DIR"
TS=$(date +%Y%m%d_%H%M%S)

sqlite3 "$BASE/nexus.db" "VACUUM INTO '$BACKUP_DIR/nexus_$TS.db'"

ls -1t "$BACKUP_DIR"/nexus_*.db 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "backup ok: $BACKUP_DIR/nexus_$TS.db ($(du -h "$BACKUP_DIR/nexus_$TS.db" | cut -f1))"

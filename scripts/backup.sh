#!/bin/bash
# NEXUS — backup do banco de conversas (SQLite WAL-safe via VACUUM INTO)
# Uso: NEXUS_BASE_DIR=/caminho scripts/backup.sh   (padrão: ~/.opencode/nexus)
set -euo pipefail

BASE="${NEXUS_BASE_DIR:-$HOME/.opencode/nexus}"
BACKUP_DIR="$BASE/backups"
KEEP=7

mkdir -p "$BACKUP_DIR"
TS=$(date +%Y%m%d_%H%M%S_%N) # nanossegundos: nunca colide em execuções seguidas

sqlite3 "$BASE/nexus.db" "VACUUM INTO '$BACKUP_DIR/nexus_$TS.db'"

ls -1t "$BACKUP_DIR"/nexus_*.db 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "backup ok: $BACKUP_DIR/nexus_$TS.db ($(du -h "$BACKUP_DIR/nexus_$TS.db" | cut -f1))"

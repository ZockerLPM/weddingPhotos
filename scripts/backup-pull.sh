#!/usr/bin/env bash
# Backup von ZUHAUSE ausführen (WSL, Linux oder macOS) – holt alle Daten
# vom Server. Der Server kann das Backup so niemals löschen (Pull-Prinzip).
#
# Aufruf:  ./backup-pull.sh deploy@SERVER-IP [Zielordner]
set -euo pipefail

SERVER="${1:?Aufruf: ./backup-pull.sh deploy@SERVER-IP [Zielordner]}"
DEST="${2:-$HOME/hochzeit-backup}"

mkdir -p "$DEST"
rsync -avz --partial "$SERVER:/opt/hochzeit/app/data/" "$DEST/"

echo ""
echo "Backup fertig: $DEST"
echo "Fotos: $(find "$DEST/photos" -type f 2>/dev/null | wc -l) Dateien"

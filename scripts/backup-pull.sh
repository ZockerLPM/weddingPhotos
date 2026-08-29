#!/usr/bin/env bash
# Backup von ZUHAUSE ausführen (WSL, Linux oder macOS) – holt alle Daten vom
# Server. Pull-Prinzip: ein kompromittierter Server kann das Backup nicht
# mitlöschen.
#
#   ./backup-pull.sh deploy@SERVER-IP [Zielordner]
#
# Optional per Umgebungsvariable:
#   SSH_KEY=~/.ssh/hochzeit      Schlüsseldatei
#   REMOTE_DIR=/opt/hochzeit/app Projektverzeichnis auf dem Server
set -euo pipefail

SERVER="${1:?Aufruf: ./backup-pull.sh deploy@SERVER-IP [Zielordner]}"
DEST="${2:-$HOME/hochzeit-backup}"
REMOTE_DIR="${REMOTE_DIR:-/opt/hochzeit/app}"

SSH_CMD=(ssh)
[ -n "${SSH_KEY:-}" ] && SSH_CMD=(ssh -i "$SSH_KEY")

# Ohne geladenen Schlüssel fragt jeder Verbindungsaufbau nach der Passphrase.
if ! ssh-add -l >/dev/null 2>&1; then
  echo "Hinweis: Der Schlüssel liegt nicht im ssh-agent – es folgen Passphrase-Abfragen."
  echo '  Einmalig:  eval $(ssh-agent -s) && ssh-add ~/.ssh/hochzeit'
  echo ""
fi

mkdir -p "$DEST/photos"

# ---------------------------------------------------------------------------
# 1. Konsistenten Datenbank-Schnappschuss auf dem Server erzeugen.
#
# Der Server schreibt im WAL-Modus. Die Datei einfach zu kopieren kann einen
# halben Schreibvorgang erwischen. VACUUM INTO erzeugt dagegen eine in sich
# stimmige Kopie, ohne den laufenden Betrieb zu stören.
# ---------------------------------------------------------------------------
SNIPPET=$(cat <<'JS'
const D = require('better-sqlite3');
const fs = require('fs');
try { fs.unlinkSync('/data/app-snapshot.db'); } catch (e) {}
const db = new D('/data/app.db', { readonly: true });
db.exec("VACUUM INTO '/data/app-snapshot.db'");
db.close();
console.log('Schnappschuss erstellt');
JS
)
B64=$(printf '%s' "$SNIPPET" | base64 | tr -d '\n')

echo "→ Datenbank-Schnappschuss auf dem Server …"
if ! "${SSH_CMD[@]}" "$SERVER" \
     "cd '$REMOTE_DIR' && docker compose exec -T app node -e \"eval(Buffer.from('$B64','base64').toString())\"" 2>/dev/null
then
  echo "  Schnappschuss nicht möglich – es wird die Live-Datenbank kopiert."
  echo "  (Für eine saubere Kopie den Server kurz stoppen: docker compose stop app)"
  SNAPSHOT_OK=0
else
  SNAPSHOT_OK=1
fi

# ---------------------------------------------------------------------------
# 2. Dateien holen.
#
# WICHTIG für Windows-Laufwerke unter WSL (/mnt/c/...): Dort scheitern
# Rechte-, Eigentümer- und Gruppen-Operationen mit
#   mkstemp ... failed: Operation not permitted (1)
# Deshalb NICHT -a verwenden, sondern gezielt ohne diese Operationen
# arbeiten und mit --inplace die temporären Dateien ganz vermeiden.
# ---------------------------------------------------------------------------
RSYNC_OPTS=(
  -rt                    # rekursiv, Zeitstempel (für den Abgleich nötig)
  --inplace              # keine .tmp-Dateien -> kein mkstemp auf DrvFs
  --no-perms             # keine chmod-Versuche
  --no-owner --no-group  # keine chown-Versuche
  --omit-dir-times       # Verzeichniszeiten lässt DrvFs nicht setzen
  --modify-window=2      # NTFS-Zeitstempel sind gröber
  --partial
  -h --info=progress2
)
[ -n "${SSH_KEY:-}" ] && RSYNC_OPTS+=(-e "ssh -i $SSH_KEY")

# Fotos sind unveränderlich und eindeutig benannt – Größenvergleich genügt
# und spart auf einem Windows-Laufwerk viel Zeitstempel-Ärger.
echo "→ Fotos und Videos …"
rsync "${RSYNC_OPTS[@]}" --size-only \
  "$SERVER:$REMOTE_DIR/data/photos/" "$DEST/photos/"

echo "→ Datenbank …"
if [ "$SNAPSHOT_OK" = "1" ]; then
  rsync "${RSYNC_OPTS[@]}" "$SERVER:$REMOTE_DIR/data/app-snapshot.db" "$DEST/app.db"
else
  rsync "${RSYNC_OPTS[@]}" "$SERVER:$REMOTE_DIR/data/app.db"* "$DEST/"
fi

COUNT=$(find "$DEST/photos" -type f 2>/dev/null | wc -l)
SIZE=$(du -sh "$DEST" 2>/dev/null | cut -f1)
echo
echo "Backup fertig: $DEST"
echo "  $COUNT Dateien, $SIZE"

# 📷 Hochzeits-Fotowand

Gäste machen Fotos mit dem eigenen Handy und laden sie ohne App und ohne
Login über den Browser hoch. Neue Fotos erscheinen Sekunden später auf der
**Fotowand** (Beamer/TV) mit einem Highlight-Effekt. Nach der Hochzeit wird
die **Galerie** freigeschaltet – ansehen, filtern, Originale herunterladen,
alles als ZIP.

## Die vier Seiten

| URL | Zweck | Wer |
|---|---|---|
| `/` | Foto-Upload (QR-Code führt hierher) | alle Gäste |
| `/show` | Fotowand im Vollbild | Beamer/TV-Rechner |
| `/galerie` | Galerie mit Download – gesperrt bis zur Freischaltung | alle Gäste, nach dem Fest |
| `/mod#SCHLÜSSEL` | Moderation: Fotos ausblenden, Fotowand steuern, Galerie öffnen | Trauzeuge/in |

## Wie es funktioniert

**Zweistufiger Upload** – die zentrale Design-Entscheidung:

1. Der Browser des Gasts verkleinert das Foto sofort (Canvas, max. 1600 px,
   ~200–400 KB). Dieses kleine Bild wird zuerst hochgeladen → das Foto ist
   nach **2–4 Sekunden auf der Fotowand**, auch bei schlechtem Netz.
2. Das Original in voller Qualität lädt danach im Hintergrund hoch, mit
   automatischen Wiederholversuchen (IndexedDB-Warteschlange, übersteht
   Reload und Netzausfall).

Nebeneffekt: Weil das Anzeigebild im Browser entsteht, kommt beim Server
immer JPEG an – **HEIC/Bildformate sind serverseitig kein Thema**.

**Live-Updates** laufen über Server-Sent Events (`/api/stream`). Jedes Event
hat eine fortlaufende ID; nach einem Verbindungsabbruch liefert der Server
alles Verpasste automatisch nach. Die Fotowand läuft bei Netzausfall aus
ihrem lokalen Pool weiter.

**Fotowand-Logik:** Neue Fotos kommen in eine Highlight-Warteschlange
(großes Bild, „Gerade eben von Anna", 12 s). Dazwischen läuft eine
Ambient-Rotation mit gewichtetem Zufall: Neues wird bevorzugt, oft
Gezeigtes tritt zurück, nichts wiederholt sich innerhalb von 10 Minuten.
Ken-Burns-Effekt und unscharfer Hintergrund für Hochformat-Fotos inklusive.

## Projektstruktur

```
server/           Node.js-Backend (Express, SQLite, SSE)
  index.js        Routen: Upload, Feed, Stream, Moderation, ZIP, Health
  db.js           SQLite-Schema und Zugriffe (better-sqlite3, WAL)
  sse.js          Event-Verteiler mit Nachhol-Logik
  ulid.js         Zeitlich sortierbare Foto-IDs
public/           Frontend, reines HTML/CSS/JS ohne Build-Schritt
  index.html      Upload-Seite         + js/upload.js, js/queue.js
  show.html       Fotowand             + js/show.js
  galerie.html    Galerie              + js/gallery.js
  mod.html        Moderation           + js/mod.js
scripts/          backup-pull.sh (Backup von zuhause holen)
data/             entsteht zur Laufzeit: app.db + photos/ (nicht im Git)
```

Gespeicherte Dateien pro Foto: `photos/{id}-d.jpg` (Anzeige),
`{id}-t.jpg` (Thumbnail), `{id}-o.{ext}` (Original, sobald hochgeladen).

## Konfiguration

`.env` (Vorlage: `.env.example`):

| Variable | Bedeutung |
|---|---|
| `DOMAIN` | Deine Domain, z. B. `fotos.example.ch` – A-Record muss auf den Server zeigen |
| `MOD_KEY` | Geheimer Schlüssel für Moderation. Erzeugen: `openssl rand -hex 16` |
| `TZ` | Zeitzone, Standard `Europe/Zurich` |

Ohne gesetzten `MOD_KEY` startet der Server absichtlich nicht.

## Lokal ausprobieren (Windows)

```powershell
npm install
$env:MOD_KEY = 'test'
npm start
```

Dann: <http://localhost:3000> (Upload), `/show`, `/mod#test`, `/galerie`.
Die Daten landen in `./data/`. Tipp: Handy im selben WLAN über
`http://<PC-IP>:3000` testen – Achtung, ohne HTTPS gibt es keinen Service
Worker, der Upload selbst funktioniert aber.

## Installation auf dem VPS

Voraussetzungen (durch die Cloud-Config beim Server-Anlegen bereits erfüllt):

- Ubuntu 24.04, Docker + Compose installiert, Benutzer `deploy`
- Hetzner-Firewall: TCP 22, 80, 443 (+ UDP 443) offen
- DNS: **A-Record** `fotos.example.ch → Server-IPv4`
  (optional AAAA → IPv6). Vorher prüfen: `nslookup fotos.example.ch`

### 1. Code auf den Server bringen

**Variante A – über GitHub (empfohlen, macht Updates leicht):**

```bash
# Lokal (einmalig): privates Repo anlegen und pushen
git remote add origin git@github.com:DEIN-NAME/weddingPhotos.git
git push -u origin main

# Auf dem Server:
ssh hochzeit
git clone https://github.com/DEIN-NAME/weddingPhotos.git /opt/hochzeit/app
```

**Variante B – direkt kopieren (PowerShell, ohne GitHub):**

```powershell
scp -i $env:USERPROFILE\.ssh\hochzeit -r `
  server public package.json Dockerfile docker-compose.yml Caddyfile .env.example .dockerignore `
  deploy@SERVER-IP:/opt/hochzeit/app/
```

### 2. Konfigurieren

```bash
cd /opt/hochzeit/app
cp .env.example .env
openssl rand -hex 16          # Ausgabe als MOD_KEY eintragen
nano .env                     # DOMAIN und MOD_KEY setzen
```

### 3. Starten

```bash
docker compose up -d --build
docker compose logs -f        # Caddy holt das TLS-Zertifikat automatisch
```

### 4. Prüfen

```bash
curl -s localhost:3000/api/health   # {"ok":true,...}
```

Im Browser: `https://fotos.example.ch` → Upload-Seite. Ein Testfoto
hochladen, `/show` daneben öffnen – es muss binnen Sekunden erscheinen.

`restart: unless-stopped` sorgt dafür, dass nach einem Server-Reboot alles
von selbst wieder hochkommt.

### Updates einspielen

```bash
cd /opt/hochzeit/app
git pull                      # bzw. erneut per scp kopieren
docker compose up -d --build
```

Danach in der Moderation „Fotowand neu laden" drücken, damit der
Beamer-Browser den neuen Stand zieht.

## Bedienung

### Fotowand einrichten (Beamer/TV)

Laptop per HDMI, Browser im Kiosk-Modus:

```bash
# Linux/Raspberry Pi
chromium-browser --kiosk --noerrdialogs --disable-infobars https://fotos.example.ch/show
```

```powershell
# Windows
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk https://fotos.example.ch/show
```

Ohne Kiosk-Modus: Seite öffnen und **Doppelklick** → Vollbild.
Die Seite hält den Bildschirm per Wake Lock wach – zusätzlich im
Betriebssystem den Ruhezustand deaktivieren (Windows: Energieoptionen;
Pi: `xset s off -dpms`).

### Moderation

Auf dem Handy der zuständigen Person **einmal**
`https://fotos.example.ch/mod#DEIN_MOD_KEY` öffnen – der Schlüssel wird
gespeichert und aus der URL entfernt. Funktionen:

- **Foto antippen** → sofort von Fotowand und Galerie ausgeblendet
  (nichts wird gelöscht; nochmal antippen macht es rückgängig)
- **Pause** → Fotowand friert ein (für Reden). **Weiter** → läuft weiter
- **Ruhe-Modus** → keine Highlight-Unterbrechungen, Rotation läuft ruhig weiter
- **Galerie öffnen/schliessen** → schaltet `/galerie` für alle frei
- **Fotowand neu laden** → nach einem Update

### Galerie freischalten

Nach dem Fest in der Moderation „Galerie öffnen", dann den Link
`https://fotos.example.ch/galerie` an alle Gäste schicken.
ZIP-Download vorher testen: `/api/gallery/zip?key=DEIN_MOD_KEY`
funktioniert auch bei geschlossener Galerie.

### QR-Codes für die Tischkarten

Zwei Codes nebeneinander drucken (z. B. mit einem beliebigen QR-Generator):

1. **WLAN** (falls eigenes WLAN): Inhalt `WIFI:T:WPA;S:NetzName;P:passwort;;`
2. **Upload-Seite**: Inhalt `https://fotos.example.ch`

Darunter die URL in Klartext für Geräte, bei denen der Scan hakt.

## Backup

Drei Ebenen, von automatisch bis manuell:

1. **Hetzner-Backups** (beim Server aktiviert): tägliche Snapshots des
   ganzen Servers. Wiederherstellung über die Hetzner-Konsole.
2. **Pull von zuhause** – wichtigste Ebene, weil unabhängig von Hetzner:

   ```bash
   # In WSL (einmalig: sudo apt install rsync)
   ./scripts/backup-pull.sh deploy@SERVER-IP
   ```

   Am Hochzeitsabend und am Tag danach je einmal ausführen.
3. **Nach dem Fest**: `data/`-Ordner zusätzlich auf eine externe Platte
   kopieren (3-2-1-Regel). Erst dann den Server kündigen.

**Wiederherstellung** auf einem frischen Server: Repo klonen, `.env`
anlegen, gesichertes `data/` nach `/opt/hochzeit/app/data/` kopieren,
`docker compose up -d --build` – fertig.

## Checkliste vor dem Fest

- [ ] **Generalprobe ~2 Wochen vorher** in der Location: 5 echte Handys
      (mind. 1 iPhone, 1 Android), Upload + Fotowand + Moderation testen
- [ ] Mobilfunk-Empfang aller grossen Netze in der Location messen
      (Upload-Speedtest, nicht nur Balken)
- [ ] Beamer-Rechner: Kiosk-Autostart, Ruhezustand aus, Ton aus
- [ ] Moderations-Handy eingerichtet (nicht deins – du heiratest)
- [ ] QR-Codes gedruckt und an den Tischen verteilt
- [ ] `watch df -h` einmal anschauen: genug Platz? (`/api/health` zeigt es auch)
- [ ] Externes Monitoring auf `https://fotos.example.ch/api/health`
      (z. B. UptimeRobot, kostenlos, alle 5 min)
- [ ] Backup-Pull einmal komplett durchgespielt
- [ ] Zettel mit WLAN-Daten, URL und „Bei Problemen: X fragen" ausgedruckt

## Troubleshooting

| Symptom | Ursache / Lösung |
|---|---|
| `docker compose logs app` zeigt „MOD_KEY fehlt" | `.env` nicht angelegt oder Platzhalter nicht ersetzt |
| Kein TLS-Zertifikat | DNS zeigt noch nicht auf den Server (`nslookup`), oder Port 80 zu. `docker compose logs caddy` |
| Upload bricht mit 413 ab | Datei > 512 MB. Limit in `Caddyfile` (`max_size`) und `server/index.js` (`upOriginal`) erhöhen |
| Fotos erscheinen nicht live auf `/show` | `docker compose logs caddy` – SSE braucht `flush_interval -1` (ist konfiguriert). Browser-Konsole auf `/show` prüfen |
| „wartet auf Netz" hängt ewig | Handy hat Captive-Portal-WLAN ohne Internet → Mobilfunk nutzen. Seite offen lassen, Queue sendet automatisch nach |
| HEIC-Foto schlägt auf Android fehl | Android-Chrome kann HEIC nicht dekodieren (iPhone-Fotos via Messenger). Betroffene Gäste: Foto stattdessen aus der Kamera-App teilen |
| Platte läuft voll | `df -h`; Volume in Hetzner-Konsole anhängen, in compose als zusätzlichen Mount für `./data` nutzen |
| Galerie-ZIP bricht ab | Bei sehr grossen Sammlungen Browser-Download-Timeout – einzelne Tage/Gäste laden oder ZIP per `curl -O` ziehen |

## Bewusste Grenzen

- **Kein Login für Gäste** – Schutz besteht darin, dass die URL nur den
  Gästen bekannt ist (`noindex` ist gesetzt). Für eine Hochzeit angemessen.
- **„Galerie geschlossen" ist weich**: Die Foto-Metadaten sind per API
  lesbar, der ZIP-Download ist hart gesperrt. Wer das Datum der API-Routen
  kennt und JS liest, könnte einzelne Bild-URLs erraten – reale Gefahr: gering.
- **Videos > 300 MB** werden nicht mit hochgeladen (nur Vorschaubild),
  Videos > 512 MB serverseitig abgelehnt.
- **Ausblenden statt Löschen**: Moderation versteckt Dateien, löscht sie
  nicht. Endgültiges Löschen: Datei aus `data/photos/` entfernen und
  Zeile aus der DB löschen (oder einfach versteckt lassen).
- **Keine Rate-Limits** – bei einer geschlossenen Gästerunde unnötig.

## Kosten (zur Erinnerung)

Hetzner CX22 + IPv4 + Backups ≈ **5 €/Monat**, stundengenau abgerechnet.
Nach dem Fest und dem letzten Backup: Server löschen, Kosten stoppen.

/* Bestandsprüfung: Datenbank gegen die Dateien auf der Platte.
 *
 * Findet Dateien ohne Datenbankeintrag (unsichtbar in Fotowand, Moderation
 * und Galerie), Einträge ohne Dateien, und Originale, die zwar auf der
 * Platte liegen, aber nicht verknüpft sind.
 *
 * Aufruf auf dem Server (im Container, ohne Argumente):
 *   docker compose exec -T -e DATA_DIR=/data app node < scripts/check-data.cjs
 *
 * Oder lokal gegen einen Backup-Ordner:
 *   DATA_DIR=/pfad/zum/backup node scripts/check-data.cjs
 *
 * Reparieren statt nur berichten:
 *   ... -e DATA_DIR=/data -e REPAIR=1 app node < scripts/check-data.cjs
 *
 * REPAIR macht zwei Dinge:
 *   1. Nicht verknüpfte Originale (-o.*) wieder am Eintrag anmelden.
 *   2. Verwaiste Bildpaare (-d/-t ohne Eintrag) als Foto aufnehmen, damit
 *      sie wieder auftauchen. Der Name ist dann unbekannt – über die
 *      Umgebungsvariable ADOPT_NAME setzbar.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const PHOTOS = path.join(DATA_DIR, 'photos');
const TMP = path.join(DATA_DIR, 'tmp');
const REPAIR = process.env.REPAIR === '1';
const ADOPT_NAME = process.env.ADOPT_NAME || 'Unbekannt';

const Database = require('better-sqlite3');
const db = new Database(path.join(DATA_DIR, 'app.db'));

const n = (x) => String(x).padStart(6);
const line = (s) => console.log(s);

// ---------------------------------------------------------------- Einlesen

const rows = db.prepare('SELECT * FROM photos').all();
const byId = new Map(rows.map((r) => [r.id, r]));

let files = [];
try { files = fs.readdirSync(PHOTOS); } catch { /* Ordner fehlt */ }

// Dateien nach Foto-ID gruppieren:  {ID}-d.jpg / -t.jpg / -o.{ext}
const onDisk = new Map();
const fremd = [];
for (const name of files) {
  // Dateinamen sind {ULID}-d.jpg, -t.jpg oder -o.{endung}
  const m = /^([0-9A-Z]{26})-([dto])\.([a-z0-9]{1,5})$/i.exec(name);
  if (!m) { fremd.push(name); continue; }
  const id = m[1];
  const slot = m[2];
  if (!onDisk.has(id)) onDisk.set(id, {});
  const rec = onDisk.get(id);
  if (slot === 'o') rec.o = name;
  else rec[slot] = name;
}

// ---------------------------------------------------------------- Auswerten

const sichtbar = rows.filter((r) => !r.hidden);
const versteckt = rows.filter((r) => r.hidden);
const nachArt = {};
for (const r of rows) nachArt[r.kind] = (nachArt[r.kind] || 0) + 1;

const fehlendAnzeige = [];   // Eintrag da, Anzeigebild fehlt
const fehlendOriginal = [];  // has_original=1, Datei fehlt
const nichtVerknuepft = [];  // -o Datei da, has_original=0
for (const r of rows) {
  const d = onDisk.get(r.id) || {};
  if (!d.d) fehlendAnzeige.push(r);
  if (r.has_original && !d.o) fehlendOriginal.push(r);
  if (!r.has_original && d.o) nichtVerknuepft.push({ row: r, file: d.o });
}

const verwaist = [];         // Dateien ohne Eintrag
for (const [id, d] of onDisk) {
  if (!byId.has(id)) verwaist.push({ id, ...d });
}

let tmpDateien = [];
try { tmpDateien = fs.readdirSync(TMP); } catch { /* egal */ }

// ---------------------------------------------------------------- Bericht

line('');
line('=== Datenbank ===');
line(`${n(rows.length)}  Einträge gesamt`);
line(`${n(sichtbar.length)}  davon sichtbar (Fotowand, Galerie, ZIP)`);
line(`${n(versteckt.length)}  davon von der Moderation ausgeblendet`);
for (const [k, v] of Object.entries(nachArt)) line(`${n(v)}  Art: ${k}`);
line(`${n(rows.filter((r) => r.archive).length)}  als Altfoto eingestuft`);
line(`${n(rows.filter((r) => r.has_original).length)}  mit Original`);

line('');
line('=== Dateien in photos/ ===');
line(`${n(files.length)}  Dateien gesamt`);
line(`${n(onDisk.size)}  verschiedene Foto-IDs`);
line(`${n([...onDisk.values()].filter((d) => d.d).length)}  Anzeigebilder (-d.jpg)`);
line(`${n([...onDisk.values()].filter((d) => d.t).length)}  Vorschaubilder (-t.jpg)`);
line(`${n([...onDisk.values()].filter((d) => d.o).length)}  Originale (-o.*)`);
line('');
line('  Hinweis: pro Foto liegen bis zu DREI Dateien. Die Gesamtzahl der');
line('  Dateien ist also normalerweise etwa dreimal so hoch wie die Zahl');
line('  der Fotos in Fotowand und Galerie.');

const probleme = verwaist.length + fehlendAnzeige.length +
                 fehlendOriginal.length + nichtVerknuepft.length;

line('');
line('=== Auffälligkeiten ===');
line(`${n(verwaist.length)}  Dateien OHNE Datenbankeintrag (unsichtbar!)`);
line(`${n(nichtVerknuepft.length)}  Originale liegen da, sind aber nicht verknüpft`);
line(`${n(fehlendAnzeige.length)}  Einträge ohne Anzeigebild`);
line(`${n(fehlendOriginal.length)}  Einträge mit Original-Verweis, Datei fehlt`);
line(`${n(fremd.length)}  Dateien mit unbekanntem Namensmuster`);
line(`${n(tmpDateien.length)}  Reste in tmp/ (abgebrochene Uploads)`);

if (verwaist.length) {
  line('');
  line('  Verwaiste IDs (erste 10):');
  for (const v of verwaist.slice(0, 10)) {
    line(`    ${v.id}  ${[v.d && 'Anzeige', v.t && 'Vorschau', v.o && 'Original']
      .filter(Boolean).join(' + ')}`);
  }
}
if (fremd.length) {
  line('');
  line('  Unbekannte Dateinamen (erste 5): ' + fremd.slice(0, 5).join(', '));
}

// Einträge, bei denen nur das Anzeigebild vorliegt. Typisch: Videos, die zu
// gross fürs Hochladen waren, oder abgebrochene Übertragungen. Diese lassen
// sich nachreichen – in der Moderation unter "Originale nachreichen" oder
// von Hand (siehe README).
const ohneOriginal = rows.filter((r) => !r.has_original && !r.hidden);
if (ohneOriginal.length) {
  line('');
  line('=== Ohne Original (nur Anzeigebild) ===');
  line(`${n(ohneOriginal.length)}  Einträge, davon ` +
       `${ohneOriginal.filter((r) => r.kind !== 'photo').length} Videos/Botschaften`);
  line('');
  line('  ID                          Art       Wer              Wann');
  for (const r of ohneOriginal.slice(0, 40)) {
    const wann = new Date(r.effective_at || r.uploaded_at)
      .toLocaleString('de-AT', { day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit' });
    line('  ' + r.id + '  ' + String(r.kind).padEnd(9) +
         String(r.uploader).slice(0, 15).padEnd(16) + wann);
  }
  if (ohneOriginal.length > 40) {
    line(`  … und ${ohneOriginal.length - 40} weitere`);
  }
  line('');
  line('  Nachreichen: Datei als  {ID}-o.{endung}  nach data/photos/ legen');
  line('  und dieses Skript mit REPAIR=1 laufen lassen – oder bequemer über');
  line('  die Moderation unter "Originale nachreichen".');
}

// ---------------------------------------------------------------- Reparatur

if (!REPAIR) {
  line('');
  if (probleme === 0) {
    line('Alles stimmig – Datenbank und Dateien passen zusammen.');
  } else {
    line('Zum Beheben denselben Aufruf mit  -e REPAIR=1  wiederholen.');
  }
  db.close();
  process.exit(0);
}

line('');
line('=== Reparatur ===');

// 1. Originale wieder anmelden – die ID steht im Dateinamen, also sicher.
const markOriginal = db.prepare(
  'UPDATE photos SET has_original = 1, ext_original = ?, original_bytes = ? WHERE id = ?');
let verknuepft = 0;
for (const { row, file } of nichtVerknuepft) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!/^[a-z0-9]{1,5}$/.test(ext)) continue;
  let bytes = 0;
  try { bytes = fs.statSync(path.join(PHOTOS, file)).size; } catch { /* egal */ }
  markOriginal.run(ext, bytes, row.id);
  verknuepft++;
}
line(`${n(verknuepft)}  Originale wieder verknüpft`);

// 1b. Verweise auf verschwundene Originale zurücknehmen – sonst liefert die
//     Galerie einen toten Download statt des vorhandenen Anzeigebilds.
const clearOriginal = db.prepare(
  'UPDATE photos SET has_original = 0, ext_original = NULL WHERE id = ?');
let bereinigt = 0;
for (const r of fehlendOriginal) { clearOriginal.run(r.id); bereinigt++; }
if (bereinigt) line(`${n(bereinigt)}  tote Original-Verweise entfernt`);

// 2. Verwaiste Bildpaare aufnehmen. Ohne Anzeigebild geht es nicht – ein
//    reines Original ohne Vorschau lässt sich nicht darstellen.
const insert = db.prepare(`
  INSERT INTO photos (id, client_id, uploader, device_id, kind, caption,
                      challenge_id, width, height, taken_at, uploaded_at,
                      archive, effective_at, time_source,
                      has_original, ext_original, hidden)
  VALUES (@id, @clientId, @uploader, '', @kind, @caption,
          NULL, NULL, NULL, @takenAt, @uploadedAt,
          0, @effectiveAt, 'datei', @hasOriginal, @extOriginal, 0)`);

let aufgenommen = 0;
let uebersprungen = 0;
for (const v of verwaist) {
  if (!v.d) { uebersprungen++; continue; }
  let mtime = Date.now();
  try { mtime = fs.statSync(path.join(PHOTOS, v.d)).mtimeMs; } catch { /* egal */ }
  const ext = v.o ? path.extname(v.o).slice(1).toLowerCase() : null;
  const kind = ext && !['jpg', 'jpeg', 'png', 'heic'].includes(ext) ? 'video' : 'photo';
  try {
    insert.run({
      id: v.id,
      clientId: 'wiederhergestellt-' + v.id,
      uploader: ADOPT_NAME,
      kind,
      caption: 'nachträglich wiederhergestellt',
      takenAt: Math.round(mtime),
      uploadedAt: Math.round(mtime),
      effectiveAt: Math.round(mtime),
      hasOriginal: v.o ? 1 : 0,
      extOriginal: ext,
    });
    aufgenommen++;
  } catch (e) {
    uebersprungen++;
  }
}
line(`${n(aufgenommen)}  verwaiste Fotos in die Datenbank aufgenommen (als "${ADOPT_NAME}")`);
if (uebersprungen) line(`${n(uebersprungen)}  übersprungen (kein Anzeigebild vorhanden)`);

// 3. Alte tmp-Reste entfernen.
let geloescht = 0;
for (const name of tmpDateien) {
  try { fs.unlinkSync(path.join(TMP, name)); geloescht++; } catch { /* egal */ }
}
if (geloescht) line(`${n(geloescht)}  Reste aus tmp/ entfernt`);

line('');
line('Fertig. Auf der Fotowand "neu laden" drücken, damit sie den neuen');
line('Stand zieht – oder die Seite /show einmal neu öffnen.');
db.close();

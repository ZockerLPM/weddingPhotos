import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const TMP_DIR = path.join(DATA_DIR, 'tmp');

fs.mkdirSync(PHOTOS_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

export const dirs = { data: DATA_DIR, photos: PHOTOS_DIR, tmp: TMP_DIR };

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS photos (
    id            TEXT PRIMARY KEY,
    client_id     TEXT UNIQUE NOT NULL,
    uploader      TEXT NOT NULL,
    device_id     TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL DEFAULT 'photo',
    caption       TEXT,
    challenge_id  TEXT,
    width         INTEGER,
    height        INTEGER,
    taken_at      INTEGER,
    uploaded_at   INTEGER NOT NULL,
    ext_original  TEXT,
    mime_original TEXT,
    has_original  INTEGER NOT NULL DEFAULT 0,
    hidden        INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS events (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Schema-Nachrüstung: CREATE TABLE IF NOT EXISTS lässt bestehende Tabellen
// unangetastet, neue Spalten müssen daher einzeln ergänzt werden.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`Datenbank ergänzt: ${table}.${column}`);
  }
}
ensureColumn('photos', 'challenge_id', 'TEXT');
// Mitgebrachte Altfotos (Kinderbilder o.ä.) tragen ein Aufnahmedatum aus
// den Metadaten, das Jahrzehnte zurückliegen kann. archive markiert sie,
// effective_at ist der Zeitpunkt, der für Reihenfolge und Auszeichnungen
// zählt: das echte Aufnahmedatum, wenn es plausibel ist, sonst der Upload.
ensureColumn('photos', 'archive', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('photos', 'effective_at', 'INTEGER');
// Woher der Zeitstempel stammt: 'exif' (Auslösezeitpunkt aus den Metadaten),
// 'exif-scan', 'exif-datei', 'aufnahme' (Erzählecke) oder 'datei'
// (Rückfall auf das Dateidatum – unzuverlässig).
ensureColumn('photos', 'time_source', "TEXT NOT NULL DEFAULT 'datei'");
// Nachbereitung nach der Feier: Favoriten fürs Gästebuch der Galerie und
// eine Prüfsumme, um mehrfach hochgeladene Dateien sicher zu erkennen.
ensureColumn('photos', 'favorite', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('photos', 'sha256', 'TEXT');
// Kategorie für die Filterleiste der Galerie (Trauung, Essen, …).
ensureColumn('photos', 'category', 'TEXT');
// Merker fürs Sichten: erlaubt abzubrechen und später weiterzumachen.
ensureColumn('photos', 'reviewed', 'INTEGER NOT NULL DEFAULT 0');
// Grösse des Originals. Die Galerie muss VOR dem Herunterladen wissen,
// worauf sie sich einlässt – sonst zieht sie erst 400 MB in den Speicher
// und stellt dann fest, dass das Handy das nicht sichern kann.
ensureColumn('photos', 'original_bytes', 'INTEGER');

// Für den Bestand einmalig nachtragen.
{
  const offen = db.prepare(
    `SELECT id, ext_original FROM photos
     WHERE has_original = 1 AND original_bytes IS NULL`).all();
  if (offen.length) {
    const setzen = db.prepare('UPDATE photos SET original_bytes = ? WHERE id = ?');
    db.transaction((rows) => {
      for (const r of rows) {
        let bytes = 0;
        try {
          bytes = fs.statSync(
            path.join(PHOTOS_DIR, `${r.id}-o.${r.ext_original}`)).size;
        } catch { /* Datei fehlt – 0 verhindert erneutes Prüfen */ }
        setzen.run(bytes, r.id);
      }
    })(offen);
    console.log(`Dateigrössen nachgetragen: ${offen.length}`);
  }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_photos_sha ON photos(sha256)');
db.exec('CREATE INDEX IF NOT EXISTS idx_photos_cat ON photos(category)');

// Bestandsdaten nachziehen (36 h Fenster, 1 h Toleranz nach vorne).
db.exec(`
  UPDATE photos SET
    archive = CASE
      WHEN taken_at IS NOT NULL
       AND (uploaded_at - taken_at > 129600000 OR taken_at - uploaded_at > 3600000)
      THEN 1 ELSE 0 END,
    effective_at = CASE
      WHEN taken_at IS NULL
        OR uploaded_at - taken_at > 129600000
        OR taken_at - uploaded_at > 3600000
      THEN uploaded_at ELSE taken_at END
  WHERE effective_at IS NULL
`);

// Standardwerte, nur beim ersten Start.
db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('paused', '0')`).run();
db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('mode', 'normal')`).run();
db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('gallery_open', '0')`).run();

const stmt = {
  insertPhoto: db.prepare(`
    INSERT INTO photos (id, client_id, uploader, device_id, kind, caption,
                        challenge_id, width, height, taken_at, uploaded_at,
                        archive, effective_at, time_source)
    VALUES (@id, @clientId, @uploader, @deviceId, @kind, @caption,
            @challengeId, @width, @height, @takenAt, @uploadedAt,
            @archive, @effectiveAt, @timeSource)`),
  byClientId: db.prepare(`SELECT * FROM photos WHERE client_id = ?`),
  byId: db.prepare(`SELECT * FROM photos WHERE id = ?`),
  markOriginal: db.prepare(
    `UPDATE photos SET has_original = 1, ext_original = ?, mime_original = ?,
            original_bytes = ? WHERE id = ?`),
  setHidden: db.prepare(`UPDATE photos SET hidden = ? WHERE id = ?`),
  deletePhoto: db.prepare(`DELETE FROM photos WHERE id = ?`),
  countAll: db.prepare(`SELECT COUNT(*) AS n FROM photos`),
  setArchive: db.prepare(
    `UPDATE photos SET archive = ?, effective_at = ? WHERE id = ?`),
  setFavorite: db.prepare(`UPDATE photos SET favorite = ? WHERE id = ?`),
  setCategory: db.prepare(`UPDATE photos SET category = ? WHERE id = ?`),
  setReviewed: db.prepare(`UPDATE photos SET reviewed = ? WHERE id = ?`),
  countOffen: db.prepare(
    `SELECT COUNT(*) AS n FROM photos WHERE reviewed = 0`),
  // Zeitraum-Zuordnung: bei 800 Fotos deutlich schneller als einzeln.
  setCategoryZeitraum: db.prepare(
    `UPDATE photos SET category = ?
     WHERE hidden = 0 AND COALESCE(effective_at, uploaded_at) BETWEEN ? AND ?`),
  idsImZeitraum: db.prepare(
    `SELECT id FROM photos
     WHERE hidden = 0 AND COALESCE(effective_at, uploaded_at) BETWEEN ? AND ?`),
  setHash: db.prepare(`UPDATE photos SET sha256 = ? WHERE id = ?`),
  // Alles, was noch keine Prüfsumme hat – für die Duplikatsuche.
  ohneHash: db.prepare(
    `SELECT * FROM photos WHERE sha256 IS NULL ORDER BY id ASC`),
  // Reihenfolge nach Gast und Zeit: Grundlage für die Serien-Erkennung.
  listNachGastUndZeit: db.prepare(
    `SELECT * FROM photos
     WHERE hidden = 0 AND kind IN ('photo', 'video')
     ORDER BY uploader ASC, effective_at ASC, id ASC`),
  listFavoriten: db.prepare(
    `SELECT * FROM photos WHERE hidden = 0 AND favorite = 1
     ORDER BY effective_at ASC, id ASC`),
  listVersteckt: db.prepare(`SELECT * FROM photos WHERE hidden = 1`),
  // Einträge, bei denen nur das Anzeigebild vorliegt – meist Videos, die
  // zu gross fürs Hochladen waren.
  ohneOriginal: db.prepare(
    `SELECT * FROM photos WHERE has_original = 0 AND hidden = 0
     ORDER BY id DESC LIMIT 500`),
  listVisible: db.prepare(
    `SELECT * FROM photos WHERE hidden = 0 ORDER BY id ASC LIMIT 5000`),
  listRecent: db.prepare(`SELECT * FROM photos ORDER BY id DESC LIMIT ?`),
  counts: db.prepare(
    `SELECT COUNT(*) AS count, COUNT(DISTINCT uploader) AS uploaders
     FROM photos WHERE hidden = 0`),
  countHidden: db.prepare(`SELECT COUNT(*) AS n FROM photos WHERE hidden = 1`),
  countByUploader: db.prepare(`SELECT COUNT(*) AS n FROM photos WHERE uploader = ?`),
  // Rückblick: Bilder des Abends, chronologisch nach effective_at.
  listForRecap: db.prepare(
    `SELECT * FROM photos
     WHERE hidden = 0 AND kind IN ('photo', 'video') AND archive = 0
     ORDER BY effective_at ASC, id ASC LIMIT 5000`),
  // Mitgebrachte Altfotos für den Vorspann des Rückblicks.
  listArchive: db.prepare(
    `SELECT * FROM photos
     WHERE hidden = 0 AND kind IN ('photo', 'video') AND archive = 1
     ORDER BY COALESCE(taken_at, uploaded_at) ASC LIMIT 200`),
  // Grundlage für die Auszeichnungen am Ende des Abends.
  awardStats: db.prepare(`
    SELECT uploader,
           SUM(CASE WHEN archive = 0 THEN 1 ELSE 0 END) AS total,
           SUM(CASE WHEN archive = 1 THEN 1 ELSE 0 END) AS archives,
           SUM(CASE WHEN caption IS NOT NULL AND caption != '' THEN 1 ELSE 0 END) AS captions,
           COUNT(DISTINCT challenge_id) AS challenges,
           SUM(CASE WHEN kind = 'message' THEN 1 ELSE 0 END) AS messages,
           MIN(CASE WHEN archive = 0 THEN effective_at END) AS first_at,
           MAX(CASE WHEN archive = 0 THEN effective_at END) AS last_at
    FROM photos WHERE hidden = 0
    GROUP BY uploader`),
  getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  setSetting: db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  addEvent: db.prepare(
    `INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)`),
  eventsAfter: db.prepare(
    `SELECT seq, type, payload FROM events WHERE seq > ? ORDER BY seq ASC LIMIT 1000`),
  // Verlauf für die Moderation – neueste zuerst.
  eventsLetzte: db.prepare(
    `SELECT seq, type, payload, created_at FROM events
     ORDER BY seq DESC LIMIT ?`),
  maxSeq: db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM events`),
};

export function insertPhoto(p) { stmt.insertPhoto.run(p); }
export function byClientId(cid) { return stmt.byClientId.get(cid); }
export function byId(id) { return stmt.byId.get(id); }
export function markOriginal(id, ext, mime, bytes) {
  stmt.markOriginal.run(ext, mime, bytes || 0, id);
}
export function setHidden(id, hidden) { stmt.setHidden.run(hidden ? 1 : 0, id); }
export function deletePhoto(id) { stmt.deletePhoto.run(id); }
export function countAll() { return stmt.countAll.get().n; }
export function setArchive(id, archive, effectiveAt) {
  stmt.setArchive.run(archive ? 1 : 0, effectiveAt, id);
}
export function listVisible() { return stmt.listVisible.all(); }
export function setFavorite(id, fav) { stmt.setFavorite.run(fav ? 1 : 0, id); }
export function setCategory(id, cat) { stmt.setCategory.run(cat || null, id); }
export function setReviewed(id, v) { stmt.setReviewed.run(v ? 1 : 0, id); }
export function countOffen() { return stmt.countOffen.get().n; }
export function setCategoryZeitraum(cat, von, bis) {
  return stmt.setCategoryZeitraum.run(cat || null, von, bis).changes;
}
export function idsImZeitraum(von, bis) {
  return stmt.idsImZeitraum.all(von, bis).map((r) => r.id);
}
export function setHash(id, hash) { stmt.setHash.run(hash, id); }
export function ohneHash() { return stmt.ohneHash.all(); }
export function listNachGastUndZeit() { return stmt.listNachGastUndZeit.all(); }
export function listFavoriten() { return stmt.listFavoriten.all(); }
export function listVersteckt() { return stmt.listVersteckt.all(); }
export function ohneOriginal() { return stmt.ohneOriginal.all(); }
export function listRecent(limit = 300) { return stmt.listRecent.all(limit); }
export function counts() { return stmt.counts.get(); }
export function countHidden() { return stmt.countHidden.get().n; }
export function countByUploader(name) { return stmt.countByUploader.get(name).n; }
export function listForRecap() { return stmt.listForRecap.all(); }
export function listArchive() { return stmt.listArchive.all(); }
export function awardStats() { return stmt.awardStats.all(); }
export function getSetting(key) { return stmt.getSetting.get(key)?.value; }
export function setSetting(key, value) { stmt.setSetting.run(key, String(value)); }
export function addEvent(type, payload) {
  return Number(stmt.addEvent.run(type, payload, Date.now()).lastInsertRowid);
}
export function eventsAfter(seq) { return stmt.eventsAfter.all(seq); }
export function eventsLetzte(limit = 200) { return stmt.eventsLetzte.all(limit); }
export function maxSeq() { return stmt.maxSeq.get().seq; }
export function close() { db.close(); }

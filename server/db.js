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

// Standardwerte, nur beim ersten Start.
db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('paused', '0')`).run();
db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('mode', 'normal')`).run();
db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('gallery_open', '0')`).run();

const stmt = {
  insertPhoto: db.prepare(`
    INSERT INTO photos (id, client_id, uploader, device_id, kind, caption,
                        width, height, taken_at, uploaded_at)
    VALUES (@id, @clientId, @uploader, @deviceId, @kind, @caption,
            @width, @height, @takenAt, @uploadedAt)`),
  byClientId: db.prepare(`SELECT * FROM photos WHERE client_id = ?`),
  byId: db.prepare(`SELECT * FROM photos WHERE id = ?`),
  markOriginal: db.prepare(
    `UPDATE photos SET has_original = 1, ext_original = ?, mime_original = ? WHERE id = ?`),
  setHidden: db.prepare(`UPDATE photos SET hidden = ? WHERE id = ?`),
  listVisible: db.prepare(
    `SELECT * FROM photos WHERE hidden = 0 ORDER BY id ASC LIMIT 5000`),
  listRecent: db.prepare(`SELECT * FROM photos ORDER BY id DESC LIMIT ?`),
  counts: db.prepare(
    `SELECT COUNT(*) AS count, COUNT(DISTINCT uploader) AS uploaders
     FROM photos WHERE hidden = 0`),
  countHidden: db.prepare(`SELECT COUNT(*) AS n FROM photos WHERE hidden = 1`),
  getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  setSetting: db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  addEvent: db.prepare(
    `INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)`),
  eventsAfter: db.prepare(
    `SELECT seq, type, payload FROM events WHERE seq > ? ORDER BY seq ASC LIMIT 1000`),
  maxSeq: db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM events`),
};

export function insertPhoto(p) { stmt.insertPhoto.run(p); }
export function byClientId(cid) { return stmt.byClientId.get(cid); }
export function byId(id) { return stmt.byId.get(id); }
export function markOriginal(id, ext, mime) { stmt.markOriginal.run(ext, mime, id); }
export function setHidden(id, hidden) { stmt.setHidden.run(hidden ? 1 : 0, id); }
export function listVisible() { return stmt.listVisible.all(); }
export function listRecent(limit = 300) { return stmt.listRecent.all(limit); }
export function counts() { return stmt.counts.get(); }
export function countHidden() { return stmt.countHidden.get().n; }
export function getSetting(key) { return stmt.getSetting.get(key)?.value; }
export function setSetting(key, value) { stmt.setSetting.run(key, String(value)); }
export function addEvent(type, payload) {
  return Number(stmt.addEvent.run(type, payload, Date.now()).lastInsertRowid);
}
export function eventsAfter(seq) { return stmt.eventsAfter.all(seq); }
export function maxSeq() { return stmt.maxSeq.get().seq; }
export function close() { db.close(); }

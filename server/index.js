import express from 'express';
import multer from 'multer';
import archiver from 'archiver';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ulid } from './ulid.js';
import * as db from './db.js';
import * as sse from './sse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);
const MOD_KEY = process.env.MOD_KEY;

if (!MOD_KEY || MOD_KEY === 'bitte-aendern') {
  console.error('FEHLER: Umgebungsvariable MOD_KEY fehlt oder ist noch der Platzhalter.');
  console.error('Erzeugen mit:  openssl rand -hex 16   und in .env eintragen.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// ---------------------------------------------------------------- Helpers

const str = (v, max) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';

const intOr = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

function safeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function modAuth(req, res, next) {
  if (!safeEq(req.get('x-mod-key') || '', MOD_KEY)) {
    return res.status(401).json({ error: 'ungueltiger Schluessel' });
  }
  next();
}

function fullState() {
  return {
    paused: db.getSetting('paused') === '1',
    mode: db.getSetting('mode') || 'normal',
    galleryOpen: db.getSetting('gallery_open') === '1',
  };
}

function rowToPublic(r) {
  return {
    id: r.id,
    uploader: r.uploader,
    kind: r.kind,
    caption: r.caption || '',
    w: r.width,
    h: r.height,
    takenAt: r.taken_at,
    uploadedAt: r.uploaded_at,
    hasOriginal: !!r.has_original,
    ext: r.ext_original || null,
  };
}

function sanitizeExt(name) {
  const e = path.extname(name || '').slice(1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(e) ? e : null;
}

// ---------------------------------------------------------------- Uploads

// Anzeigebild + Thumbnail: klein, kommen aus dem Canvas des Browsers,
// dürfen im Speicher landen.
const upSmall = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 2 },
});

// Originale (auch Videos): direkt auf die Platte streamen.
const upOriginal = multer({
  storage: multer.diskStorage({
    destination: db.dirs.tmp,
    filename: (req, file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: 512 * 1024 * 1024, files: 1 },
});

// Schneller Pfad: Anzeigebild + Thumb -> Foto ist "auf der Wand".
app.post('/api/upload', upSmall.fields([
  { name: 'display', maxCount: 1 },
  { name: 'thumb', maxCount: 1 },
]), async (req, res) => {
  const clientId = str(req.body.clientId, 64);
  const uploader = str(req.body.uploader, 40);
  const display = req.files?.display?.[0];
  const thumb = req.files?.thumb?.[0];

  if (!clientId || !uploader || !display || !thumb) {
    return res.status(400).json({ error: 'unvollstaendig' });
  }

  // Idempotent: bei Wiederholung (Netz-Retry) existiert der Eintrag schon.
  const existing = db.byClientId(clientId);
  if (existing) return res.json({ id: existing.id, existed: true });

  const id = ulid();
  const row = {
    id,
    clientId,
    uploader,
    deviceId: str(req.body.deviceId, 64),
    kind: req.body.kind === 'video' ? 'video' : 'photo',
    caption: str(req.body.caption, 200) || null,
    width: intOr(req.body.w, null),
    height: intOr(req.body.h, null),
    takenAt: intOr(req.body.takenAt, Date.now()),
    uploadedAt: Date.now(),
  };

  await fsp.writeFile(path.join(db.dirs.photos, `${id}-d.jpg`), display.buffer);
  await fsp.writeFile(path.join(db.dirs.photos, `${id}-t.jpg`), thumb.buffer);
  db.insertPhoto(row);

  sse.emit('photo', rowToPublic(db.byId(id)));
  res.json({ id, existed: false });
});

// Langsamer Pfad: das Original in voller Qualität, mit Wiederholversuchen.
app.post('/api/original/:id', upOriginal.single('original'), async (req, res) => {
  const cleanup = () => req.file && fsp.unlink(req.file.path).catch(() => {});

  const p = db.byId(str(req.params.id, 26));
  if (!p) { await cleanup(); return res.status(404).json({ error: 'unbekannt' }); }
  if (!req.file) return res.status(400).json({ error: 'keine Datei' });
  if (p.has_original) { await cleanup(); return res.json({ ok: true, existed: true }); }
  // Leeres Original niemals als "vorhanden" verbuchen – sonst steht in der
  // Galerie ein kaputter Download statt des Anzeigebilds.
  if (!req.file.size) {
    await cleanup();
    return res.status(400).json({ error: 'Original war leer' });
  }

  const ext = sanitizeExt(req.file.originalname)
    || (p.kind === 'video' ? 'mp4' : 'jpg');
  await fsp.rename(req.file.path, path.join(db.dirs.photos, `${p.id}-o.${ext}`));
  db.markOriginal(p.id, ext, str(req.file.mimetype, 100));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- Lesen

app.get('/api/feed', (req, res) => {
  const c = db.counts();
  res.json({
    now: Date.now(),
    maxSeq: db.maxSeq(),
    ...fullState(),
    count: c.count,
    uploaders: c.uploaders,
    photos: db.listVisible().map(rowToPublic),
  });
});

app.get('/api/stats', (req, res) => {
  res.json(db.counts());
});

app.get('/api/stream', (req, res) => sse.handle(req, res));

app.get('/api/health', async (req, res) => {
  const out = { ok: true, db: false, disk: null, photos: 0, sseClients: sse.clientCount() };
  try {
    out.photos = db.counts().count;
    db.setSetting('health_ping', String(Date.now()));
    out.db = true;
  } catch { out.ok = false; }
  try {
    const st = await fsp.statfs(db.dirs.data);
    const freeGB = (st.bavail * st.bsize) / 1e9;
    const usedPct = Math.round((1 - st.bavail / st.blocks) * 100);
    out.disk = { freeGB: Math.round(freeGB * 10) / 10, usedPct };
    if (freeGB < 2 || usedPct > 92) out.ok = false;
  } catch { out.ok = false; }
  res.status(out.ok ? 200 : 500).json(out);
});

// ---------------------------------------------------------------- Moderation

app.post('/api/mod/hide', modAuth, (req, res) => {
  const id = str(req.body.id, 26);
  const hidden = !!req.body.hidden;
  const p = db.byId(id);
  if (!p) return res.status(404).json({ error: 'unbekannt' });
  db.setHidden(id, hidden);
  const payload = { id, hidden };
  if (!hidden) payload.photo = rowToPublic(db.byId(id));
  sse.emit('hide', payload);
  res.json({ ok: true });
});

app.post('/api/mod/control', modAuth, (req, res) => {
  const a = req.body.action;
  if (a === 'pause') db.setSetting('paused', '1');
  else if (a === 'resume') db.setSetting('paused', '0');
  else if (a === 'mode') db.setSetting('mode', req.body.mode === 'quiet' ? 'quiet' : 'normal');
  else if (a !== 'skip' && a !== 'reload') return res.status(400).json({ error: 'unbekannte Aktion' });

  const payload = { ...fullState() };
  if (a === 'skip') payload.skip = 1;
  if (a === 'reload') payload.reload = 1;
  sse.emit('control', payload);
  res.json({ ok: true, state: fullState() });
});

app.post('/api/mod/gallery', modAuth, (req, res) => {
  db.setSetting('gallery_open', req.body.open ? '1' : '0');
  sse.emit('control', { ...fullState() });
  res.json({ ok: true, state: fullState() });
});

app.get('/api/mod/list', modAuth, (req, res) => {
  const rows = db.listRecent(intOr(req.query.limit, 300));
  res.json({
    ...fullState(),
    hiddenCount: db.countHidden(),
    photos: rows.map(r => ({ ...rowToPublic(r), hidden: !!r.hidden })),
  });
});

// ---------------------------------------------------------------- Galerie-ZIP

app.get('/api/gallery/zip', (req, res) => {
  const open = db.getSetting('gallery_open') === '1';
  const modOk = req.query.key && safeEq(req.query.key, MOD_KEY);
  if (!open && !modOk) return res.status(403).json({ error: 'Galerie ist geschlossen' });

  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename="hochzeitsfotos.zip"',
  });
  // store: JPEGs/Videos sind schon komprimiert, Kompression wäre nur langsam.
  const archive = archiver('zip', { store: true });
  archive.on('error', () => res.destroy());
  archive.pipe(res);

  for (const p of db.listVisible()) {
    const date = new Date(p.taken_at || p.uploaded_at).toISOString().slice(0, 10);
    const who = (p.uploader || 'gast').replace(/[^\w\-äöüÄÖÜß]/g, '_');
    let file, name;
    if (p.has_original) {
      file = path.join(db.dirs.photos, `${p.id}-o.${p.ext_original}`);
      name = `${date}_${who}_${p.id}.${p.ext_original}`;
    } else {
      file = path.join(db.dirs.photos, `${p.id}-d.jpg`);
      name = `${date}_${who}_${p.id}.jpg`;
    }
    if (fs.existsSync(file)) archive.file(file, { name });
  }
  archive.finalize();
});

// ---------------------------------------------------------------- Statisches

// Bilddateien: IDs sind einmalig, daher aggressiv cachen.
app.use('/i', express.static(db.dirs.photos, {
  maxAge: '30d',
  immutable: true,
  index: false,
  fallthrough: false,
}));

// Seiten: /show -> show.html, /galerie -> galerie.html, /mod -> mod.html
app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'] }));

// ---------------------------------------------------------------- Fehler

// Bei jedem Fehler die schon geschriebenen Teildateien wegräumen,
// sonst sammeln sich in data/tmp/ Fragmente abgebrochener Uploads an.
function cleanupUploads(req) {
  const list = [];
  if (req.file) list.push(req.file);
  if (req.files) {
    if (Array.isArray(req.files)) list.push(...req.files);
    else for (const arr of Object.values(req.files)) list.push(...arr);
  }
  for (const f of list) {
    if (f?.path) fsp.unlink(f.path).catch(() => {});
  }
}

app.use((err, req, res, next) => {
  cleanupUploads(req);

  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Datei zu gross' });
  }

  // Abgebrochener Upload: Handy im Standby, Netz weg, Tab geschlossen.
  // Kein Serverfehler – kompakt loggen statt Stacktrace, und dem Client
  // signalisieren, dass ein erneuter Versuch sinnvoll ist.
  const aborted = err?.message === 'Unexpected end of form'
    || err?.code === 'ECONNRESET'
    || err?.code === 'ECONNABORTED'
    || req.destroyed;
  if (aborted) {
    console.warn('[Upload abgebrochen] %s  laenge=%s  ua=%s',
      req.originalUrl,
      req.get('content-length') || '?',
      (req.get('user-agent') || '-').slice(0, 70));
    if (!res.headersSent) res.status(408).json({ error: 'Upload abgebrochen' });
    return;
  }

  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'Serverfehler' });
});

// Verwaiste Teildateien aufräumen (Start + stündlich).
async function sweepTmp() {
  try {
    const now = Date.now();
    for (const name of await fsp.readdir(db.dirs.tmp)) {
      const f = path.join(db.dirs.tmp, name);
      const st = await fsp.stat(f).catch(() => null);
      if (st && now - st.mtimeMs > 2 * 3600 * 1000) {
        await fsp.unlink(f).catch(() => {});
      }
    }
  } catch { /* Verzeichnis fehlt o.ä. – unkritisch */ }
}
sweepTmp();
setInterval(sweepTmp, 3600 * 1000).unref();

const server = app.listen(PORT, () => {
  console.log(`Fotowand läuft auf Port ${PORT}, Daten in ${db.dirs.data}`);
});

process.on('SIGTERM', () => {
  server.close(() => { db.close(); process.exit(0); });
});

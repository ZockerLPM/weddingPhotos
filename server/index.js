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
import { DEFAULT_CHALLENGES, sanitizeChallenges } from './challenges.js';
import * as nach from './nachbereitung.js';
import * as videos from './videos.js';
import { DEFAULT_KATEGORIEN, sanitizeKategorien } from './kategorien.js';

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
    challengeId: r.challenge_id || null,
    archive: !!r.archive,
    favorite: !!r.favorite,
    category: r.category || null,
    reviewed: !!r.reviewed,
    effectiveAt: r.effective_at || r.uploaded_at,
    timeSource: r.time_source || 'datei',
    w: r.width,
    h: r.height,
    takenAt: r.taken_at,
    uploadedAt: r.uploaded_at,
    hasOriginal: !!r.has_original,
    ext: r.ext_original || null,
    bytes: r.original_bytes || 0,
    mobilBytes: r.mobile_bytes || 0,
    ohneOriginal: !!r.original_skip,
  };
}

// Ein mitgebrachtes Kinderbild trägt ein Aufnahmedatum von vor 30 Jahren.
// Solche Fotos sollen die Reihenfolge des Abends und die Auszeichnungen
// nicht verfälschen – sie bekommen als Zeitpunkt den Upload und ein
// eigenes Kennzeichen.
const ARCHIVE_BEFORE_MS = 36 * 3600 * 1000;  // älter als 36 h vor dem Upload
const CLOCK_SKEW_MS = 3600 * 1000;           // Handyuhr darf 1 h vorgehen

function classifyTime(takenAt, uploadedAt) {
  const isArchive = !takenAt
    || uploadedAt - takenAt > ARCHIVE_BEFORE_MS
    || takenAt - uploadedAt > CLOCK_SKEW_MS;
  return {
    archive: isArchive && !!takenAt ? 1 : 0,
    effectiveAt: isArchive ? uploadedAt : takenAt,
  };
}

/* Begrüssung über der Galerie.
 *
 * Bewusst in den Einstellungen und nicht fest im HTML: Es sind eure Worte
 * an eure Gäste, nicht meine. Der Standard ist nur ein Vorschlag.
 */
const STANDARD_GRUSS = {
  titel: 'Danke, dass ihr da wart 💛',
  text: 'Diese Bilder habt ihr alle zusammen gemacht – jedes einzelne ist ' +
        'ein Stück von unserem Tag. Schaut euch in Ruhe um und nehmt mit, ' +
        'was euch gefällt.',
};

function getGruss() {
  try {
    const roh = db.getSetting('gruss');
    if (roh) {
      const g = JSON.parse(roh);
      return {
        titel: str(g.titel, 120) || STANDARD_GRUSS.titel,
        text: str(g.text, 600) || STANDARD_GRUSS.text,
      };
    }
  } catch { /* kaputter Eintrag -> Standard */ }
  return STANDARD_GRUSS;
}

// Aufgabenliste aus den Einstellungen, mit Rückfall auf die Standardliste.
function getChallenges() {
  try {
    const raw = db.getSetting('challenges');
    if (raw) {
      const parsed = sanitizeChallenges(JSON.parse(raw));
      if (parsed && parsed.length) return parsed;
    }
  } catch { /* kaputter Eintrag -> Standard */ }
  return DEFAULT_CHALLENGES;
}

// Kategorienliste aus den Einstellungen, mit Rückfall auf den Standard.
function getKategorien() {
  try {
    const raw = db.getSetting('kategorien');
    if (raw) {
      const parsed = sanitizeKategorien(JSON.parse(raw));
      if (parsed && parsed.length) return parsed;
    }
  } catch { /* kaputter Eintrag -> Standard */ }
  return DEFAULT_KATEGORIEN;
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
  if (existing) {
    return res.json({ id: existing.id, existed: true, archive: !!existing.archive });
  }

  // Vor dem Einfügen prüfen: ist das der allererste Beitrag dieser Person?
  // Daraus wird auf der Fotowand die namentliche Begrüssung.
  const firstUpload = db.countByUploader(uploader) === 0;

  const id = ulid();
  const kind = ['photo', 'video', 'message'].includes(req.body.kind)
    ? req.body.kind : 'photo';
  const uploadedAt = Date.now();
  const takenAt = intOr(req.body.takenAt, null);
  const when = classifyTime(takenAt, uploadedAt);
  const row = {
    id,
    clientId,
    uploader,
    deviceId: str(req.body.deviceId, 64),
    kind,
    caption: str(req.body.caption, 200) || null,
    challengeId: str(req.body.challengeId, 40) || null,
    width: intOr(req.body.w, null),
    height: intOr(req.body.h, null),
    takenAt: takenAt,
    uploadedAt,
    archive: when.archive,
    effectiveAt: when.effectiveAt,
    timeSource: str(req.body.timeSource, 20) || 'datei',
  };

  // Erst nach tmp schreiben, dann den Eintrag anlegen, dann an den
  // endgültigen Platz schieben.
  //
  // Vorher wurden die Dateien direkt nach photos/ geschrieben und der
  // Datenbankeintrag danach angelegt. Scheiterte der Eintrag – etwa weil
  // zwei Wiederholversuche mit derselben clientId gleichzeitig ankamen und
  // der UNIQUE-Index zuschlug – blieben die Dateien ohne Eintrag liegen:
  // unsichtbar in Fotowand, Moderation und Galerie, aber voll auf der
  // Platte. Umbenennen ist dagegen atomar und praktisch nicht zu verfehlen.
  const zielD = path.join(db.dirs.photos, `${id}-d.jpg`);
  const zielT = path.join(db.dirs.photos, `${id}-t.jpg`);
  const tmpD = path.join(db.dirs.tmp, `${id}-d.jpg`);
  const tmpT = path.join(db.dirs.tmp, `${id}-t.jpg`);

  await fsp.writeFile(tmpD, display.buffer);
  await fsp.writeFile(tmpT, thumb.buffer);

  try {
    db.insertPhoto(row);
  } catch (e) {
    await fsp.unlink(tmpD).catch(() => {});
    await fsp.unlink(tmpT).catch(() => {});
    // Zweiter Versuch mit derselben clientId war schneller – dessen
    // Ergebnis zurückgeben statt einen Fehler zu melden.
    const doppelt = db.byClientId(clientId);
    if (doppelt) {
      return res.json({ id: doppelt.id, existed: true, archive: !!doppelt.archive });
    }
    throw e;
  }

  try {
    await fsp.rename(tmpD, zielD);
    await fsp.rename(tmpT, zielT);
  } catch (e) {
    // Kein Eintrag ohne Bilder stehen lassen.
    db.deletePhoto(id);
    await fsp.unlink(tmpD).catch(() => {});
    await fsp.unlink(tmpT).catch(() => {});
    await fsp.unlink(zielD).catch(() => {});
    throw e;
  }

  sse.emit('photo', { ...rowToPublic(db.byId(id)), firstUpload });

  // Eine knappe Zeile je Beitrag. Ohne sie lässt sich hinterher nicht
  // nachvollziehen, was am Abend ankam und was nicht.
  console.log('[upload] %s  %s  %s%s%s',
    id, kind.padEnd(7), uploader,
    row.archive ? '  (von früher)' : '',
    firstUpload ? '  (erster Beitrag)' : '');

  // archive zurückmelden, damit die Upload-Seite es dem Gast anzeigen kann.
  res.json({ id, existed: false, archive: !!row.archive });
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
  const ziel = path.join(db.dirs.photos, `${p.id}-o.${ext}`);
  await fsp.rename(req.file.path, ziel);
  try {
    db.markOriginal(p.id, ext, str(req.file.mimetype, 100), req.file.size);
  } catch (e) {
    // Sonst läge das Original unbemerkt herum und die Galerie böte
    // weiterhin nur das Anzeigebild an.
    await fsp.unlink(ziel).catch(() => {});
    throw e;
  }
  console.log('[original] %s  %s  %s MB',
    p.id, ext, Math.round(req.file.size / 1048576));
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
    challenges: getChallenges(),
    kategorien: getKategorien(),
    gruss: getGruss(),
    photos: db.listVisible().map(rowToPublic),
  });
});

app.get('/api/stats', (req, res) => {
  res.json(db.counts());
});

app.get('/api/stream', (req, res) => sse.handle(req, res));

app.get('/api/challenges', (req, res) => {
  res.json({ challenges: getChallenges() });
});

app.post('/api/mod/challenges', modAuth, (req, res) => {
  const list = sanitizeChallenges(req.body.challenges);
  if (!list) return res.status(400).json({ error: 'Liste erwartet' });
  db.setSetting('challenges', JSON.stringify(list));
  sse.emit('challenges', { challenges: list });
  res.json({ ok: true, challenges: list });
});

app.post('/api/mod/challenges/reset', modAuth, (req, res) => {
  db.setSetting('challenges', JSON.stringify(DEFAULT_CHALLENGES));
  sse.emit('challenges', { challenges: DEFAULT_CHALLENGES });
  res.json({ ok: true, challenges: DEFAULT_CHALLENGES });
});

// ---------------------------------------------------------------- Rückblick

// Kuratierte Auswahl für den Mitternachts-Rückblick: pro Zeitfenster das
// aussagekräftigste Foto, danach garantiert jeder Gast mindestens einmal.
// Mitgebrachte Altfotos eröffnen den Rückblick als kurzer Vorspann
// "Von früher" – aus dem Zeitstempel-Problem wird so ein eigenes Kapitel.
function buildArchiveIntro(limit = 8) {
  const rows = db.listArchive();
  if (rows.length <= limit) return rows.map(rowToPublic);
  const step = rows.length / limit;
  const out = [];
  for (let i = 0; i < limit; i++) out.push(rows[Math.floor(i * step)]);
  return out.map(rowToPublic);
}

function buildRecap(limit = 40) {
  const all = db.listForRecap();
  if (!all.length) return [];

  const BUCKET = 15 * 60 * 1000;
  const best = new Map();
  for (const p of all) {
    const key = Math.floor((p.effective_at || p.uploaded_at) / BUCKET);
    const score = (p.caption ? 2 : 0) + (p.challenge_id ? 1 : 0);
    const cur = best.get(key);
    if (!cur || score > cur.score) best.set(key, { p, score });
  }
  let picked = [...best.values()].map(x => x.p);

  // Bei einer kleinen Gesellschaft zählt jeder – niemand fehlt im Rückblick.
  const seen = new Set(picked.map(p => p.uploader));
  for (const p of all) {
    if (!seen.has(p.uploader)) { picked.push(p); seen.add(p.uploader); }
  }

  picked.sort((a, b) =>
    (a.effective_at || a.uploaded_at) - (b.effective_at || b.uploaded_at)
    || a.id.localeCompare(b.id));
  if (picked.length > limit) {
    const step = picked.length / limit;
    const thinned = [];
    for (let i = 0; i < limit; i++) thinned.push(picked[Math.floor(i * step)]);
    picked = thinned;
  }
  return picked.map(rowToPublic);
}

// Auszeichnungen. Titel werden möglichst auf verschiedene Gäste verteilt,
// damit bei kleiner Runde fast jeder einen bekommt.
function buildAwards() {
  const rows = db.awardStats();
  if (!rows.length) return [];
  const used = new Set();

  const give = (icon, title, rank, detail) => {
    const cands = rows.filter(r => rank(r) !== null).sort((a, b) => rank(b) - rank(a));
    if (!cands.length) return;
    const win = cands.find(c => !used.has(c.uploader)) || cands[0];
    used.add(win.uploader);
    out.push({ icon, title, who: win.uploader, detail: detail(win) });
  };

  const out = [];
  give('📸', 'Fleissigster Fotograf', r => (r.total > 0 ? r.total : null),
    r => `${r.total} Fotos vom Fest`);
  give('📼', 'Der Archivar', r => (r.archives > 0 ? r.archives : null),
    r => `${r.archives} Bilder von früher mitgebracht`);
  give('🌅', 'Der frühe Vogel', r => (r.first_at ? -r.first_at : null),
    r => 'erstes Foto um ' + new Date(r.first_at).toLocaleTimeString('de-AT',
      { hour: '2-digit', minute: '2-digit' }));
  give('🌙', 'Der Ausdauernde', r => (r.last_at ? r.last_at : null),
    r => 'letztes Foto um ' + new Date(r.last_at).toLocaleTimeString('de-AT',
      { hour: '2-digit', minute: '2-digit' }));
  give('💬', 'Der Erzähler', r => (r.captions > 0 ? r.captions : null),
    r => `${r.captions} Grüsse geschrieben`);
  give('🎯', 'Der Aufgabenjäger', r => (r.challenges > 0 ? r.challenges : null),
    r => `${r.challenges} Foto-Aufgaben erfüllt`);
  give('🎙️', 'Die Stimme des Abends', r => (r.messages > 0 ? r.messages : null),
    r => `${r.messages} Botschaften hinterlassen`);
  return out;
}

app.get('/api/recap', (req, res) => {
  res.json({
    archive: buildArchiveIntro(),
    photos: buildRecap(),
    awards: buildAwards(),
  });
});

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

// Nicht jedes Bild hat verwertbare Metadaten: ein über einen Messenger
// weitergeleitetes Kinderfoto trägt den Weiterleitungs-Zeitpunkt. Deshalb
// lässt sich die Einordnung von Hand korrigieren.
app.post('/api/mod/archive', modAuth, (req, res) => {
  const id = str(req.body.id, 26);
  const p = db.byId(id);
  if (!p) return res.status(404).json({ error: 'unbekannt' });

  const archive = !!req.body.archive;
  const effectiveAt = archive ? p.uploaded_at : (p.taken_at || p.uploaded_at);
  db.setArchive(id, archive, effectiveAt);

  const photo = rowToPublic(db.byId(id));
  sse.emit('update', photo);
  res.json({ ok: true, photo });
});

app.get('/api/categories', (req, res) => {
  res.json({ kategorien: getKategorien() });
});

app.post('/api/mod/categories', modAuth, (req, res) => {
  const liste = sanitizeKategorien(req.body.kategorien);
  if (!liste) return res.status(400).json({ error: 'Liste erwartet' });
  db.setSetting('kategorien', JSON.stringify(liste));
  sse.emit('kategorien', { kategorien: liste });
  res.json({ ok: true, kategorien: liste });
});

app.post('/api/mod/categories/reset', modAuth, (req, res) => {
  db.setSetting('kategorien', JSON.stringify(DEFAULT_KATEGORIEN));
  sse.emit('kategorien', { kategorien: DEFAULT_KATEGORIEN });
  res.json({ ok: true, kategorien: DEFAULT_KATEGORIEN });
});

/* Kategorie zuweisen – entweder für eine Liste von IDs oder für einen
 * ganzen Zeitraum. Der Zeitraum ist der schnelle Weg: „alles zwischen
 * 14:00 und 15:30 ist die Trauung" ordnet 200 Fotos auf einen Schlag zu.
 */
app.post('/api/mod/category', modAuth, (req, res) => {
  const kat = str(req.body.category, 40) || null;
  if (kat && !getKategorien().some((k) => k.id === kat)) {
    return res.status(400).json({ error: 'unbekannte Kategorie' });
  }

  if (req.body.von && req.body.bis) {
    const von = intOr(req.body.von, 0);
    const bis = intOr(req.body.bis, 0);
    if (!von || !bis || bis < von) {
      return res.status(400).json({ error: 'Zeitraum ungueltig' });
    }
    const ids = db.idsImZeitraum(von, bis);
    db.setCategoryZeitraum(kat, von, bis);
    for (const id of ids) sse.emit('update', rowToPublic(db.byId(id)));
    return res.json({ ok: true, geaendert: ids.length, ids });
  }

  const ids = Array.isArray(req.body.ids) ? req.body.ids.slice(0, 2000) : [];
  let n = 0;
  for (const roh of ids) {
    const id = str(roh, 26);
    if (!db.byId(id)) continue;
    db.setCategory(id, kat);
    sse.emit('update', rowToPublic(db.byId(id)));
    n++;
  }
  res.json({ ok: true, geaendert: n });
});

/* Originale stückweise hochladen.
 *
 * Ein grosses Video in einer einzigen Anfrage scheitert zuverlässig: Multer
 * und Caddy haben Grenzen, das Handy muss die Datei am Stück halten, und ein
 * Verbindungsabbruch bei 90 % wirft alles weg. In 8-MB-Stücken sieht keine
 * Schicht je mehr als ein Stück, der Speicherbedarf bleibt klein und ein
 * Abbruch kostet höchstens ein Stück.
 *
 * Dieselbe Maschinerie bedient zwei Wege: die Gäste beim Hochladen und die
 * Moderation beim Nachreichen.
 */
const teilLaeufe = new Map();
const TEIL_TTL = 3 * 3600 * 1000;

setInterval(() => {
  const jetzt = Date.now();
  for (const [marke, u] of teilLaeufe) {
    if (jetzt - u.zeit > TEIL_TTL) {
      fsp.unlink(u.pfad).catch(() => {});
      teilLaeufe.delete(marke);
    }
  }
}, 30 * 60 * 1000).unref();

async function teilStart(p, dateiname) {
  const ext = sanitizeExt(dateiname) || (p.kind === 'photo' ? 'jpg' : 'mp4');
  const marke = crypto.randomUUID();
  const pfad = path.join(db.dirs.tmp, 'teil-' + marke);
  await fsp.writeFile(pfad, Buffer.alloc(0));
  teilLaeufe.set(marke, { id: p.id, ext, pfad, bytes: 0, zeit: Date.now() });
  return { marke, ext };
}

async function teilAnhaengen(marke, stueck) {
  const u = teilLaeufe.get(marke);
  if (!u) return null;
  await fsp.appendFile(u.pfad, stueck);
  u.bytes += stueck.length;
  u.zeit = Date.now();
  return u;
}

// Zusammensetzen und am Eintrag vermerken. Gibt den fertigen Datensatz
// zurück oder wirft mit einer sprechenden Ursache.
async function teilFertig(marke) {
  const u = teilLaeufe.get(marke);
  if (!u) return { fehler: 410 };

  const p = db.byId(u.id);
  const aufraeumen = async () => {
    await fsp.unlink(u.pfad).catch(() => {});
    teilLaeufe.delete(marke);
  };
  if (!p) { await aufraeumen(); return { fehler: 404 }; }
  if (!u.bytes) { await aufraeumen(); return { fehler: 400 }; }

  // Ein vorhandenes Original mit anderer Endung würde sonst als Leiche
  // liegen bleiben.
  if (p.has_original && p.ext_original && p.ext_original !== u.ext) {
    await fsp.unlink(
      path.join(db.dirs.photos, `${p.id}-o.${p.ext_original}`)).catch(() => {});
  }

  const ziel = path.join(db.dirs.photos, `${p.id}-o.${u.ext}`);
  await fsp.rename(u.pfad, ziel);
  try {
    db.markOriginal(p.id, u.ext, '', u.bytes);
    console.log('[original] %s  %s  %s MB (stückweise)',
      p.id, u.ext, Math.round(u.bytes / 1048576));
  } catch (e) {
    await fsp.unlink(ziel).catch(() => {});
    teilLaeufe.delete(marke);
    throw e;
  }
  const bytes = u.bytes;
  teilLaeufe.delete(marke);

  const photo = rowToPublic(db.byId(p.id));
  sse.emit('update', photo);
  return { photo, bytes };
}

// Rohdaten der Stücke: eigener Parser, weil hier kein JSON kommt.
const teilRoh = express.raw({ type: '*/*', limit: '32mb' });

/* ---- Weg für die Gäste ----
 * Ohne Schlüssel, wie der einstufige Upload daneben – wer die Adresse der
 * Seite kennt, darf beitragen. Ein vorhandenes Original wird hier aber
 * nicht überschrieben.
 */
app.post('/api/original/:id/start', async (req, res) => {
  const p = db.byId(str(req.params.id, 26));
  if (!p) return res.status(404).json({ error: 'unbekannt' });
  if (p.has_original) return res.json({ existed: true });
  res.json(await teilStart(p, str(req.body.dateiname, 200)));
});

app.post('/api/original/:id/teil', teilRoh, async (req, res) => {
  if (!req.body || !req.body.length) {
    return res.status(400).json({ error: 'leeres Stueck' });
  }
  const marke = str(req.query.marke, 64);
  const lauf = teilLaeufe.get(marke);
  if (!lauf) return res.status(410).json({ error: 'Upload abgelaufen' });

  // Zugehörigkeit prüfen, BEVOR etwas angehängt wird – sonst landen die
  // Daten in der Datei und werden erst danach abgelehnt.
  if (lauf.id !== str(req.params.id, 26)) {
    return res.status(400).json({ error: 'Marke gehoert zu einem anderen Beitrag' });
  }

  const u = await teilAnhaengen(marke, req.body);
  res.json({ bytes: u.bytes });
});

app.post('/api/original/:id/fertig', async (req, res) => {
  const r = await teilFertig(str(req.body.marke, 64));
  if (r.fehler) return res.status(r.fehler).json({ error: 'nicht abschliessbar' });
  res.json({ ok: true, bytes: r.bytes });
});

/* Eine Sichtungs-Aktion in einem Zug.
 *
 * Der Viewer soll pro Tastendruck genau eine Anfrage stellen – bei 871
 * Fotos summieren sich zwei Anfragen je Bild sonst spürbar. Angewendet
 * wird nur, was mitgeschickt wurde; fehlende Felder bleiben unberührt.
 */
app.post('/api/mod/sichten', modAuth, (req, res) => {
  const id = str(req.body.id, 26);
  if (!db.byId(id)) return res.status(404).json({ error: 'unbekannt' });

  if (typeof req.body.hidden === 'boolean') db.setHidden(id, req.body.hidden);
  if (typeof req.body.favorite === 'boolean') db.setFavorite(id, req.body.favorite);
  if (typeof req.body.reviewed === 'boolean') db.setReviewed(id, req.body.reviewed);

  if ('category' in req.body) {
    const kat = str(req.body.category, 40) || null;
    if (kat && !getKategorien().some((k) => k.id === kat)) {
      return res.status(400).json({ error: 'unbekannte Kategorie' });
    }
    db.setCategory(id, kat);
  }

  const photo = rowToPublic(db.byId(id));
  // Die Fotowand hört auf 'hide', alle anderen Ansichten auf 'update'.
  if (typeof req.body.hidden === 'boolean') {
    sse.emit('hide', {
      id, hidden: req.body.hidden,
      photo: req.body.hidden ? undefined : photo,
    });
  }
  sse.emit('update', photo);
  res.json({ ok: true, photo, offen: db.countOffen() });
});

/* Verlauf aus der Ereignistabelle.
 *
 * Der eigentliche Server-Log liegt bei Docker und wird irgendwann gedreht.
 * Die Ereignisse stehen dagegen in der Datenbank und überleben jeden
 * Neustart – das ist der verlässlichere Rückblick auf den Abend.
 */
app.get('/api/mod/verlauf', modAuth, (req, res) => {
  const limit = Math.min(intOr(req.query.limit, 200), 1000);
  const zeilen = db.eventsLetzte(limit).map((e) => {
    let d = {};
    try { d = JSON.parse(e.payload); } catch { /* kaputt -> leer */ }
    return {
      seq: e.seq,
      zeit: e.created_at,
      art: e.type,
      id: d.id || null,
      wer: d.uploader || null,
      kind: d.kind || null,
      hidden: typeof d.hidden === 'boolean' ? d.hidden : null,
    };
  });
  res.json({ zeilen, gesamt: db.maxSeq() });
});

app.get('/api/mod/fehlende-originale', modAuth, (req, res) => {
  // Mit ?alle=1 auch die als „kein Original" abgehakten – falls doch noch
  // eine Datei auftaucht.
  const alle = req.query.alle === '1';
  const rows = alle ? db.ohneOriginalAlle() : db.ohneOriginal();
  res.json({
    eintraege: rows.map(rowToPublic),
    uebersprungen: db.uebersprungen(),
    zeigtAlle: alle,
  });
});

/* „Kein Original vorhanden oder gewünscht."
 *
 * Manche Aufnahmen bekommen nie ein Original – das Video ist verloren, der
 * Gast hat es nicht mehr, oder es lohnt schlicht nicht. Ohne diesen Weg
 * stünden sie für immer auf der Nachreichliste und man wüsste nie, ob man
 * fertig ist.
 */
app.post('/api/mod/kein-original', modAuth, (req, res) => {
  const id = str(req.body.id, 26);
  if (!db.byId(id)) return res.status(404).json({ error: 'unbekannt' });
  db.setOriginalSkip(id, req.body.skip !== false);
  const photo = rowToPublic(db.byId(id));
  sse.emit('update', photo);
  res.json({ ok: true, photo, offen: db.ohneOriginal().length });
});

/* ---- Weg für die Moderation ----
 * Darf im Gegensatz zum Gäste-Weg ein vorhandenes Original ersetzen.
 */
app.post('/api/mod/nachreichen/start', modAuth, async (req, res) => {
  const p = db.byId(str(req.body.id, 26));
  if (!p) return res.status(404).json({ error: 'unbekannt' });
  res.json(await teilStart(p, str(req.body.dateiname, 200)));
});

app.post('/api/mod/nachreichen/teil', modAuth, teilRoh, async (req, res) => {
  if (!req.body || !req.body.length) {
    return res.status(400).json({ error: 'leeres Stueck' });
  }
  const u = await teilAnhaengen(str(req.query.marke, 64), req.body);
  if (!u) return res.status(410).json({ error: 'Upload abgelaufen' });
  res.json({ bytes: u.bytes });
});

app.post('/api/mod/nachreichen/fertig', modAuth, async (req, res) => {
  const r = await teilFertig(str(req.body.marke, 64));
  if (r.fehler === 410) return res.status(410).json({ error: 'Upload abgelaufen' });
  if (r.fehler === 404) return res.status(404).json({ error: 'unbekannt' });
  if (r.fehler) return res.status(400).json({ error: 'nichts empfangen' });
  res.json({ ok: true, bytes: r.bytes, photo: r.photo });
});

app.post('/api/mod/gruss', modAuth, (req, res) => {
  const titel = str(req.body.titel, 120);
  const text = str(req.body.text, 600);
  if (!titel && !text) {
    db.setSetting('gruss', '');           // leer = Standard
    sse.emit('gruss', STANDARD_GRUSS);
    return res.json({ ok: true, gruss: STANDARD_GRUSS });
  }
  db.setSetting('gruss', JSON.stringify({ titel, text }));
  const gruss = getGruss();
  sse.emit('gruss', gruss);
  res.json({ ok: true, gruss });
});

/* Zeitpunkte korrigieren.
 *
 * Manche Aufnahmen tragen ein falsches Datum – etwa weil die Datei keine
 * Metadaten hatte und das Dateidatum genommen wurde, oder weil ein
 * nachträglich wiederhergestellter Eintrag das Datum seiner Datei erbte.
 * Für die Reihenfolge zählt effective_at; genau das lässt sich hier
 * geradeziehen. Das ursprüngliche taken_at bleibt unangetastet – es ist
 * die Aufzeichnung dessen, was in der Datei stand.
 */
function tagSchluessel(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

app.get('/api/mod/datum', modAuth, (req, res) => {
  const nachTag = new Map();
  for (const p of db.tageUebersicht()) {
    const t = tagSchluessel(p.effective_at || p.uploaded_at);
    if (!nachTag.has(t)) nachTag.set(t, { tag: t, anzahl: 0, archive: 0, ids: [] });
    const e = nachTag.get(t);
    e.anzahl++;
    if (p.archive) e.archive++;
    if (e.ids.length < 2000) e.ids.push(p.id);
  }
  const tage = [...nachTag.values()].sort((a, b) => a.tag.localeCompare(b.tag));

  // Der Tag mit den meisten Aufnahmen ist mit grosser Sicherheit der
  // Hochzeitstag – als Vorschlag gut genug.
  let haupttag = null;
  for (const t of tage) if (!haupttag || t.anzahl > haupttag.anzahl) haupttag = t;

  res.json({
    tage: tage.map(({ tag, anzahl, archive }) => ({ tag, anzahl, archive })),
    vorschlag: db.getSetting('hochzeitstag') || (haupttag ? haupttag.tag : null),
    heute: tagSchluessel(Date.now()),
  });
});

app.post('/api/mod/datum', modAuth, (req, res) => {
  const ziel = str(req.body.tag, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ziel);
  if (!m) return res.status(400).json({ error: 'Datum erwartet (JJJJ-MM-TT)' });

  // Entweder eine Liste von IDs oder alle eines Quelltages.
  let rows;
  if (Array.isArray(req.body.ids) && req.body.ids.length) {
    rows = req.body.ids.slice(0, 5000)
      .map((v) => db.byId(str(v, 26))).filter(Boolean);
  } else {
    const quelle = str(req.body.vonTag, 10);
    if (!quelle) return res.status(400).json({ error: 'Quelle fehlt' });
    rows = db.tageUebersicht().filter(
      (p) => tagSchluessel(p.effective_at || p.uploaded_at) === quelle);
  }
  if (!rows.length) return res.json({ ok: true, geaendert: 0 });

  const behalteZeit = req.body.uhrzeitBehalten !== false;
  const alsAbend = req.body.alsAbend === true;

  let n = 0;
  for (const p of rows) {
    const alt = new Date(p.effective_at || p.uploaded_at);
    const neu = new Date(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      behalteZeit ? alt.getHours() : 12,
      behalteZeit ? alt.getMinutes() : 0,
      behalteZeit ? alt.getSeconds() : 0);
    db.setZeitpunkt(p.id, neu.getTime(), alsAbend ? 0 : p.archive);
    sse.emit('update', rowToPublic(db.byId(p.id)));
    n++;
  }
  db.setSetting('hochzeitstag', ziel);
  console.log('[datum] %d Aufnahmen auf %s verschoben', n, ziel);
  res.json({ ok: true, geaendert: n });
});

app.post('/api/mod/favorite', modAuth, (req, res) => {
  const id = str(req.body.id, 26);
  if (!db.byId(id)) return res.status(404).json({ error: 'unbekannt' });
  db.setFavorite(id, !!req.body.favorite);
  const photo = rowToPublic(db.byId(id));
  sse.emit('update', photo);
  res.json({ ok: true, photo });
});

// Mehrere auf einmal ausblenden – für Serien und Duplikate.
app.post('/api/mod/hide-many', modAuth, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.slice(0, 2000) : [];
  const hidden = !!req.body.hidden;
  let n = 0;
  for (const roh of ids) {
    const id = str(roh, 26);
    if (!db.byId(id)) continue;
    db.setHidden(id, hidden);
    sse.emit('hide', { id, hidden, photo: hidden ? undefined : rowToPublic(db.byId(id)) });
    n++;
  }
  res.json({ ok: true, geaendert: n });
});

app.get('/api/mod/serien', modAuth, (req, res) => {
  res.json({ serien: nach.serien() });
});

app.post('/api/mod/hashes', modAuth, async (req, res) => {
  res.json(await nach.hashesNachtragen());
});

app.get('/api/mod/hashes', modAuth, (req, res) => {
  res.json(nach.hashStatus());
});

app.get('/api/mod/duplikate', modAuth, (req, res) => {
  res.json({ ...nach.hashStatus(), gruppen: nach.duplikate() });
});

app.get('/api/mod/handyversionen', modAuth, async (req, res) => {
  res.json({
    ...videos.status(),
    offen: videos.offeneAnzahl(),
    moeglich: await videos.ffmpegVorhanden(),
  });
});

app.post('/api/mod/handyversionen', modAuth, async (req, res) => {
  res.json(await videos.erzeugen());
});

app.post('/api/mod/downloads', modAuth, async (req, res) => {
  res.json(await nach.downloadsBauen({
    klein: req.body.klein !== false,
    fotos: req.body.fotos !== false,
    videos: req.body.videos !== false,
    kategorien: req.body.kategorien !== false,
    teilMB: intOr(req.body.teilMB, 0),
  }));
});

app.get('/api/mod/downloads', modAuth, (req, res) => {
  res.json(nach.bauStatus());
});

// Was würde entstehen? Zeigt die Pakete mit Anzahl und Grösse, ohne
// etwas zu bauen – damit man vorher weiss, worauf man sich einlässt.
app.get('/api/mod/downloads/vorschau', modAuth, (req, res) => {
  res.json(nach.vorschau({
    teilMB: intOr(req.query.teilMB, 0),
  }));
});

// Endgültiges Löschen. Absichtlich mit Bestätigungswort, damit es nicht
// aus Versehen per Tippfehler passiert.
app.post('/api/mod/loeschen', modAuth, async (req, res) => {
  if (req.body.bestaetigung !== 'LOESCHEN') {
    return res.status(400).json({ error: 'Bestätigung fehlt' });
  }
  const ergebnis = await nach.verworfeneLoeschen();
  res.json({ ok: true, ...ergebnis });
});

app.post('/api/mod/control', modAuth, (req, res) => {
  const a = req.body.action;
  if (a === 'pause') db.setSetting('paused', '1');
  else if (a === 'resume') db.setSetting('paused', '0');
  else if (a === 'mode') db.setSetting('mode', req.body.mode === 'quiet' ? 'quiet' : 'normal');
  else if (!['skip', 'reload', 'recap'].includes(a)) {
    return res.status(400).json({ error: 'unbekannte Aktion' });
  }

  const payload = { ...fullState() };
  if (a === 'skip') payload.skip = 1;
  if (a === 'reload') payload.reload = 1;
  if (a === 'recap') payload.recap = 1;
  sse.emit('control', payload);
  res.json({ ok: true, state: fullState() });
});

app.post('/api/mod/gallery', modAuth, (req, res) => {
  db.setSetting('gallery_open', req.body.open ? '1' : '0');
  sse.emit('control', { ...fullState() });
  res.json({ ok: true, state: fullState() });
});

app.get('/api/mod/list', modAuth, (req, res) => {
  // Vorher lag die Voreinstellung bei 300 und die Seite forderte 500 an –
  // bei mehr Fotos fehlte der Rest in der Moderation kommentarlos.
  const limit = Math.min(intOr(req.query.limit, 2000), 5000);
  const rows = db.listRecent(limit);
  res.json({
    ...fullState(),
    hiddenCount: db.countHidden(),
    total: db.countAll(),          // damit eine Kürzung sichtbar wird
    offen: db.countOffen(),        // noch nicht gesichtet
    shown: rows.length,
    photos: rows.map(r => ({ ...rowToPublic(r), hidden: !!r.hidden })),
  });
});

// ---------------------------------------------------------------- Galerie-ZIP

/* Auswahl-Marken für den ZIP-Download beliebiger Zusammenstellungen.
 *
 * Ein Download muss ein GET sein, damit der Browser ihn wie eine Datei
 * behandelt – eine lange Liste von IDs passt aber nicht zuverlässig in
 * eine URL. Deshalb legt die Galerie die Auswahl per POST ab und lädt
 * anschliessend mit der zurückgegebenen Marke.
 */
const auswahlen = new Map();
const AUSWAHL_TTL = 2 * 3600 * 1000;

function auswahlAufraeumen() {
  const jetzt = Date.now();
  for (const [marke, a] of auswahlen) {
    if (jetzt - a.zeit > AUSWAHL_TTL) auswahlen.delete(marke);
  }
}
setInterval(auswahlAufraeumen, 15 * 60 * 1000).unref();

app.post('/api/gallery/auswahl', (req, res) => {
  if (db.getSetting('gallery_open') !== '1' &&
      !(req.body.key && safeEq(req.body.key, MOD_KEY))) {
    return res.status(403).json({ error: 'Galerie ist geschlossen' });
  }
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : [])
    .slice(0, 2000).map((v) => str(v, 26)).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'leere Auswahl' });

  auswahlAufraeumen();
  const marke = crypto.randomUUID();
  auswahlen.set(marke, { ids: new Set(ids), zeit: Date.now() });
  res.json({ marke, anzahl: ids.length });
});

// Fertige Pakete und Lieblingsbilder für die Galerie.
app.get('/api/gallery/downloads', (req, res) => {
  const offen = db.getSetting('gallery_open') === '1';
  if (!offen && !(req.query.key && safeEq(req.query.key, MOD_KEY))) {
    return res.status(403).json({ error: 'Galerie ist geschlossen' });
  }
  const m = nach.manifest();
  res.json({
    gebaut: m ? m.gebaut : null,
    pakete: m ? m.pakete : [],
    gaeste: [...new Set(db.listVisible().map((p) => p.uploader))]
      .sort((a, b) => a.localeCompare(b, 'de')),
    kategorien: getKategorien(),
  });
});

app.get('/api/gallery/zip', (req, res) => {
  const open = db.getSetting('gallery_open') === '1';
  const modOk = req.query.key && safeEq(req.query.key, MOD_KEY);
  if (!open && !modOk) return res.status(403).json({ error: 'Galerie ist geschlossen' });

  const nurGast = str(req.query.gast, 40);
  const art = str(req.query.art, 10);
  const kategorie = str(req.query.kategorie, 40);
  const marke = str(req.query.auswahl, 64);
  const auswahl = marke ? auswahlen.get(marke) : null;

  // Abgelaufene oder unbekannte Marke NICHT stillschweigend ignorieren –
  // sonst käme statt der Auswahl die komplette Galerie, und wer auf
  // "ZIP" tippt, bekommt unerwartet mehrere Gigabyte. Diese Prüfung muss
  // vor die ZIP-Kopfzeilen, damit die Fehlermeldung als JSON ankommt.
  if (marke && !auswahl) {
    return res.status(410).json({ error: 'Auswahl abgelaufen – bitte neu wählen' });
  }

  const teilName = nurGast || kategorie || art || (marke ? 'auswahl' : '');
  const dateiname = teilName
    ? 'hochzeit-' + teilName.replace(/[^\w\-]/g, '_') + '.zip'
    : 'hochzeitsfotos.zip';
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename="' + dateiname + '"',
  });
  // store: JPEGs/Videos sind schon komprimiert, Kompression wäre nur langsam.
  const archive = archiver('zip', { store: true });
  archive.on('error', () => res.destroy());
  archive.pipe(res);

  // Auf einen Gast oder eine Art eingrenzen. Diese Auswahlen sind klein
  // genug, um sie im Fluge zu erzeugen; die grossen Pakete liegen fertig
  // unter /d/ und lassen sich dadurch fortsetzen.
  for (const p of db.listVisible()) {
    if (auswahl && !auswahl.ids.has(p.id)) continue;
    if (kategorie && p.category !== kategorie) continue;
    if (nurGast && p.uploader !== nurGast) continue;
    if (art === 'favoriten' && !p.favorite) continue;
    if (art === 'foto' && p.kind !== 'photo') continue;
    if (art === 'video' && p.kind === 'photo') continue;
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

/* Fertige Download-Pakete.
 *
 * express.static beantwortet Bereichsanfragen (Range), dadurch lassen sich
 * abgebrochene Downloads fortsetzen – der entscheidende Unterschied zu
 * einem im Fluge erzeugten ZIP.
 */
app.use('/d', (req, res, next) => {
  if (db.getSetting('gallery_open') === '1') return next();
  if (req.query.key && safeEq(req.query.key, MOD_KEY)) return next();
  res.status(403).json({ error: 'Galerie ist geschlossen' });
}, express.static(nach.downloadDir, {
  index: false,
  fallthrough: false,
  maxAge: '1h',
}));

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

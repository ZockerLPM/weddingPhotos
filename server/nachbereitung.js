/* Nachbereitung nach der Feier.
 *
 * Vier Dinge, die alle erst hinterher gebraucht werden:
 *   - Serien erkennen (Aufnahmen desselben Gasts in wenigen Sekunden)
 *   - echte Duplikate über eine Prüfsumme finden
 *   - Download-Pakete als fertige ZIP-Dateien auf der Platte erzeugen
 *   - ausgeblendete Beiträge endgültig entfernen
 *
 * Warum die ZIPs vorab erzeugt werden statt im Fluge: Ein gestreamtes ZIP
 * hat keine bekannte Länge und lässt sich nicht fortsetzen. Bricht die
 * Verbindung bei 4 von 5 GB ab, fängt der Gast wieder bei null an – auf
 * dem Handy scheitert das praktisch immer. Eine fertige Datei liefert der
 * Server dagegen mit Längenangabe und Bereichsanfragen aus; ein Abbruch
 * setzt dort fort, wo er aufhörte.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import archiver from 'archiver';
import * as db from './db.js';
import { DEFAULT_KATEGORIEN, sanitizeKategorien } from './kategorien.js';

function kategorien() {
  try {
    const roh = db.getSetting('kategorien');
    if (roh) {
      const liste = sanitizeKategorien(JSON.parse(roh));
      if (liste && liste.length) return liste;
    }
  } catch { /* kaputt -> Standard */ }
  return DEFAULT_KATEGORIEN;
}

// Zielgrösse je Teil. 1,5 GB laden auch ältere Geräte noch am Stück.
const TEIL_BYTES = Number(process.env.ZIP_TEIL_MB || 1500) * 1024 * 1024;
const SERIE_MS = Number(process.env.SERIE_SEKUNDEN || 10) * 1000;

export const downloadDir = path.join(db.dirs.data, 'downloads');
fs.mkdirSync(downloadDir, { recursive: true });

const dateiVon = (id, slot, ext) =>
  path.join(db.dirs.photos, `${id}-${slot}.${ext || 'jpg'}`);

function groesse(datei) {
  try { return fs.statSync(datei).size; } catch { return 0; }
}

// Name im ZIP: sortierbar nach Datum, Fotograf erkennbar, Kollisionen
// durch die ID ausgeschlossen.
function zipName(p) {
  const datum = new Date(p.effective_at || p.uploaded_at).toISOString().slice(0, 10);
  const wer = (p.uploader || 'gast').replace(/[^\w\-äöüÄÖÜß]/g, '_');
  const ext = p.has_original ? p.ext_original : 'jpg';
  return `${datum}_${wer}_${p.id}.${ext}`;
}

// ---------------------------------------------------------------- Serien

/* Aufnahmen desselben Gasts, die dicht beieinander liegen.
 *
 * Bei 800 Fotos aus einer kleinen Runde sind das erfahrungsgemäss viele:
 * dreimal dieselbe Szene, weil man nachdrückt. Gruppiert lässt sich das
 * schnell zusammenstreichen.
 */
export function serien() {
  const rows = db.listNachGastUndZeit();
  const gruppen = [];
  let aktuell = [];

  const abschliessen = () => {
    if (aktuell.length >= 2) gruppen.push(aktuell);
    aktuell = [];
  };

  for (const p of rows) {
    if (!aktuell.length) { aktuell = [p]; continue; }
    const vorher = aktuell[aktuell.length - 1];
    const zeitlichNah =
      Math.abs((p.effective_at || p.uploaded_at) -
               (vorher.effective_at || vorher.uploaded_at)) <= SERIE_MS;
    if (vorher.uploader === p.uploader && zeitlichNah) aktuell.push(p);
    else { abschliessen(); aktuell = [p]; }
  }
  abschliessen();

  return gruppen.map((g) => ({
    uploader: g[0].uploader,
    von: g[0].effective_at || g[0].uploaded_at,
    sekunden: Math.round(
      ((g[g.length - 1].effective_at || g[g.length - 1].uploaded_at) -
       (g[0].effective_at || g[0].uploaded_at)) / 1000),
    ids: g.map((p) => p.id),
  }));
}

// ------------------------------------------------------------- Duplikate

function hashDatei(datei) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(datei);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

let hashLauf = { laeuft: false, fertig: 0, gesamt: 0 };
export const hashStatus = () => ({ ...hashLauf });

/* Prüfsummen nachtragen. Läuft im Hintergrund, weil dabei alle Originale
 * einmal gelesen werden – bei 5 GB dauert das eine Weile.
 */
export async function hashesNachtragen() {
  if (hashLauf.laeuft) return hashStatus();
  const offen = db.ohneHash();
  hashLauf = { laeuft: true, fertig: 0, gesamt: offen.length };

  (async () => {
    for (const p of offen) {
      // Das Original ist aussagekräftiger; fehlt es, tut es das Anzeigebild.
      const datei = p.has_original
        ? dateiVon(p.id, 'o', p.ext_original)
        : dateiVon(p.id, 'd', 'jpg');
      try {
        db.setHash(p.id, await hashDatei(datei));
      } catch {
        db.setHash(p.id, 'fehlt');   // nicht immer wieder versuchen
      }
      hashLauf.fertig++;
    }
    hashLauf.laeuft = false;
  })();

  return hashStatus();
}

/* Gruppen mit identischem Inhalt. Nur exakte Übereinstimmung – das ist
 * sicher. Ähnliche Bilder zu erkennen wäre Ratewerk und würde am Ende
 * echte Aufnahmen wegwerfen.
 */
export function duplikate() {
  const nachHash = new Map();
  for (const p of db.listVisible()) {
    if (!p.sha256 || p.sha256 === 'fehlt') continue;
    if (!nachHash.has(p.sha256)) nachHash.set(p.sha256, []);
    nachHash.get(p.sha256).push(p);
  }
  const out = [];
  for (const [hash, gruppe] of nachHash) {
    if (gruppe.length < 2) continue;
    gruppe.sort((a, b) => a.id.localeCompare(b.id));
    out.push({
      hash: hash.slice(0, 12),
      behalten: gruppe[0].id,                      // der älteste bleibt
      weg: gruppe.slice(1).map((p) => p.id),
      uploader: [...new Set(gruppe.map((p) => p.uploader))],
    });
  }
  return out;
}

// ------------------------------------------------------------- Downloads

let bauLauf = { laeuft: false, schritt: '', fertig: 0, gesamt: 0, fehler: null };
export const bauStatus = () => ({ ...bauLauf, pakete: manifest() });

export function manifest() {
  try {
    const roh = db.getSetting('downloads');
    return roh ? JSON.parse(roh) : null;
  } catch { return null; }
}

// Ein Paket schreiben und die tatsächliche Grösse zurückgeben.
function paketSchreiben(datei, eintraege) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(datei);
    // store: JPEG und MP4 sind bereits komprimiert, Packen brächte nichts
    // ausser Rechenzeit.
    const zip = archiver('zip', { store: true });
    out.on('close', () => resolve(zip.pointer()));
    out.on('error', reject);
    zip.on('error', reject);
    zip.pipe(out);
    for (const e of eintraege) {
      if (fs.existsSync(e.quelle)) zip.file(e.quelle, { name: e.name });
      bauLauf.fertig++;
    }
    zip.finalize();
  });
}

// Nach Zielgrösse in Teile schneiden.
function inTeile(eintraege, grenze) {
  const max = grenze || TEIL_BYTES;
  const teile = [];
  let aktuell = [];
  let summe = 0;
  for (const e of eintraege) {
    if (aktuell.length && summe + e.bytes > max) {
      teile.push(aktuell);
      aktuell = [];
      summe = 0;
    }
    aktuell.push(e);
    summe += e.bytes;
  }
  if (aktuell.length) teile.push(aktuell);
  return teile;
}

const alsEintrag = (p) => ({
  quelle: p.has_original ? dateiVon(p.id, 'o', p.ext_original) : dateiVon(p.id, 'd'),
  name: zipName(p),
  bytes: groesse(p.has_original ? dateiVon(p.id, 'o', p.ext_original) : dateiVon(p.id, 'd')),
});

/* Was soll gebaut werden?
 *
 * Bewusst eine einzige Beschreibung für Vorschau UND Bau – sonst zeigt die
 * Vorschau etwas anderes, als hinterher entsteht.
 *
 * wahl: { klein, fotos, videos, kategorien } je true/false, teilMB als Zahl
 */
export function zusammenstellung(wahl) {
  const w = Object.assign(
    { klein: true, fotos: true, videos: true, kategorien: true, teilMB: 0 }, wahl || {});
  const grenze = w.teilMB > 0 ? w.teilMB * 1024 * 1024 : TEIL_BYTES;

  const sichtbar = db.listVisible();
  const gruppen = [];

  if (w.klein) {
    const liste = sichtbar.map((p) => ({
      quelle: dateiVon(p.id, 'd'),
      name: `${new Date(p.effective_at || p.uploaded_at).toISOString().slice(0, 10)}` +
            `_${(p.uploader || 'gast').replace(/[^\w\-äöüÄÖÜß]/g, '_')}_${p.id}.jpg`,
      bytes: groesse(dateiVon(p.id, 'd')),
    }));
    if (liste.length) {
      gruppen.push({
        art: 'klein', basis: 'hochzeit-klein',
        titel: 'Alle Fotos in Bildschirmgrösse',
        hinweis: 'Zum Anschauen und Teilen – passt auf jedes Handy.',
        teile: [liste],           // bewusst nicht schneiden, ist klein genug
      });
    }
  }

  if (w.fotos) {
    const liste = sichtbar
      .filter((p) => p.kind === 'photo' && p.has_original).map(alsEintrag);
    if (liste.length) {
      gruppen.push({
        art: 'foto', basis: 'hochzeit-fotos',
        titel: 'Alle Fotos in Originalgrösse',
        hinweis: 'Volle Auflösung, zum Drucken geeignet.',
        teile: inTeile(liste, grenze),
      });
    }
  }

  if (w.videos) {
    const liste = sichtbar
      .filter((p) => (p.kind === 'video' || p.kind === 'message') && p.has_original)
      .map(alsEintrag);
    if (liste.length) {
      gruppen.push({
        art: 'video', basis: 'hochzeit-videos',
        titel: 'Alle Videos',
        hinweis: 'Videos und Botschaften aus der Erzählecke.',
        teile: inTeile(liste, grenze),
      });
    }
  }

  if (w.kategorien) {
    for (const k of kategorien()) {
      const liste = sichtbar.filter((p) => p.category === k.id).map(alsEintrag);
      if (!liste.length) continue;
      gruppen.push({
        art: 'kategorie', kategorie: k.id, basis: `hochzeit-${k.id}`,
        titel: `${k.icon} ${k.name}`,
        hinweis: 'Nur die Aufnahmen aus dieser Kategorie, in Originalgrösse.',
        teile: inTeile(liste, grenze),
      });
    }
  }

  return { wahl: w, gruppen };
}

// Für die Anzeige: Pakete mit Namen, Anzahl und geschätzter Grösse.
export function vorschau(wahl) {
  const { gruppen } = zusammenstellung(wahl);
  const pakete = [];
  for (const g of gruppen) {
    g.teile.forEach((teil, i) => {
      pakete.push({
        datei: g.teile.length === 1 ? `${g.basis}.zip` : `${g.basis}-${i + 1}.zip`,
        art: g.art,
        kategorie: g.kategorie || null,
        titel: g.titel + (g.teile.length > 1
          ? ` – Teil ${i + 1} von ${g.teile.length}` : ''),
        hinweis: g.hinweis,
        anzahl: teil.length,
        bytes: teil.reduce((n, e) => n + e.bytes, 0),
      });
    });
  }
  return {
    pakete,
    gesamt: pakete.reduce((n, p) => n + p.bytes, 0),
    dateien: pakete.reduce((n, p) => n + p.anzahl, 0),
  };
}

export async function downloadsBauen(wahl) {
  if (bauLauf.laeuft) return bauStatus();

  const { gruppen } = zusammenstellung(wahl);

  bauLauf = {
    laeuft: true,
    schritt: 'wird vorbereitet',
    fertig: 0,
    gesamt: gruppen.reduce(
      (n, g) => n + g.teile.reduce((m, t) => m + t.length, 0), 0),
    fehler: null,
  };

  (async () => {
    try {
      // Alte Pakete zuerst weg, sonst bleiben Reste einer früheren
      // Aufteilung liegen und verwirren.
      for (const alt of await fsp.readdir(downloadDir).catch(() => [])) {
        await fsp.unlink(path.join(downloadDir, alt)).catch(() => {});
      }

      // Aus derselben Zusammenstellung bauen, die auch die Vorschau zeigt.
      const pakete = [];
      for (const g of gruppen) {
        for (let i = 0; i < g.teile.length; i++) {
          const mehrteilig = g.teile.length > 1;
          bauLauf.schritt = g.titel + (mehrteilig ? ` (Teil ${i + 1})` : ``);
          const datei = mehrteilig ? `${g.basis}-${i + 1}.zip` : `${g.basis}.zip`;
          const bytes = await paketSchreiben(path.join(downloadDir, datei), g.teile[i]);
          pakete.push({
            datei, bytes, anzahl: g.teile[i].length,
            art: g.art,
            kategorie: g.kategorie || null,
            titel: g.titel + (mehrteilig ? ` – Teil ${i + 1} von ${g.teile.length}` : ``),
            hinweis: g.hinweis,
          });
        }
      }

      db.setSetting('downloads', JSON.stringify({ gebaut: Date.now(), pakete }));
      bauLauf.schritt = 'fertig';
    } catch (e) {
      bauLauf.fehler = e && e.message ? e.message : 'unbekannter Fehler';
    } finally {
      bauLauf.laeuft = false;
    }
  })();

  return bauStatus();
}

// --------------------------------------------------------------- Löschen

/* Ausgeblendete Beiträge endgültig entfernen: erst die Dateien, dann den
 * Eintrag. Umgekehrt bliebe bei einem Abbruch eine Datei ohne Eintrag
 * liegen – genau der Zustand, den wir nicht wollen.
 */
export async function verworfeneLoeschen() {
  const weg = db.listVersteckt();
  let dateien = 0;
  for (const p of weg) {
    for (const datei of [
      dateiVon(p.id, 'd'), dateiVon(p.id, 't'),
      p.ext_original ? dateiVon(p.id, 'o', p.ext_original) : null,
    ]) {
      if (!datei) continue;
      try { await fsp.unlink(datei); dateien++; } catch { /* war schon weg */ }
    }
    db.deletePhoto(p.id);
  }
  return { eintraege: weg.length, dateien };
}

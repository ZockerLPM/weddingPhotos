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
function inTeile(eintraege) {
  const teile = [];
  let aktuell = [];
  let summe = 0;
  for (const e of eintraege) {
    if (aktuell.length && summe + e.bytes > TEIL_BYTES) {
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

export async function downloadsBauen() {
  if (bauLauf.laeuft) return bauStatus();

  const sichtbar = db.listVisible();
  const fotos = sichtbar.filter((p) => p.kind === 'photo' && p.has_original);
  const bewegt = sichtbar.filter(
    (p) => (p.kind === 'video' || p.kind === 'message') && p.has_original);

  const alsEintrag = (p) => ({
    quelle: p.has_original ? dateiVon(p.id, 'o', p.ext_original) : dateiVon(p.id, 'd'),
    name: zipName(p),
    bytes: groesse(p.has_original ? dateiVon(p.id, 'o', p.ext_original) : dateiVon(p.id, 'd')),
  });

  const kleinListe = sichtbar.map((p) => ({
    quelle: dateiVon(p.id, 'd'),
    name: `${new Date(p.effective_at || p.uploaded_at).toISOString().slice(0, 10)}` +
          `_${(p.uploader || 'gast').replace(/[^\w\-äöüÄÖÜß]/g, '_')}_${p.id}.jpg`,
    bytes: groesse(dateiVon(p.id, 'd')),
  }));
  const fotoListe = fotos.map(alsEintrag);
  const videoListe = bewegt.map(alsEintrag);

  const fotoTeile = inTeile(fotoListe);
  const videoTeile = inTeile(videoListe);

  bauLauf = {
    laeuft: true,
    schritt: 'wird vorbereitet',
    fertig: 0,
    gesamt: kleinListe.length + fotoListe.length + videoListe.length +
            sichtbar.filter((p) => p.category).length,
    fehler: null,
  };

  (async () => {
    try {
      // Alte Pakete zuerst weg, sonst bleiben Reste einer früheren
      // Aufteilung liegen und verwirren.
      for (const alt of await fsp.readdir(downloadDir).catch(() => [])) {
        await fsp.unlink(path.join(downloadDir, alt)).catch(() => {});
      }

      const pakete = [];

      if (kleinListe.length) {
        bauLauf.schritt = 'Kleine Version';
        const datei = 'hochzeit-klein.zip';
        const bytes = await paketSchreiben(path.join(downloadDir, datei), kleinListe);
        pakete.push({
          datei, bytes, anzahl: kleinListe.length, art: 'klein',
          titel: 'Alle Fotos in Bildschirmgrösse',
          hinweis: 'Zum Anschauen und Teilen – passt auf jedes Handy.',
        });
      }

      for (let i = 0; i < fotoTeile.length; i++) {
        bauLauf.schritt = `Fotos, Teil ${i + 1} von ${fotoTeile.length}`;
        const datei = fotoTeile.length === 1
          ? 'hochzeit-fotos.zip' : `hochzeit-fotos-${i + 1}.zip`;
        const bytes = await paketSchreiben(path.join(downloadDir, datei), fotoTeile[i]);
        pakete.push({
          datei, bytes, anzahl: fotoTeile[i].length, art: 'foto',
          titel: fotoTeile.length === 1
            ? 'Alle Fotos in Originalgrösse'
            : `Fotos in Originalgrösse – Teil ${i + 1} von ${fotoTeile.length}`,
          hinweis: 'Volle Auflösung, zum Drucken geeignet.',
        });
      }

      for (let i = 0; i < videoTeile.length; i++) {
        bauLauf.schritt = `Videos, Teil ${i + 1} von ${videoTeile.length}`;
        const datei = videoTeile.length === 1
          ? 'hochzeit-videos.zip' : `hochzeit-videos-${i + 1}.zip`;
        const bytes = await paketSchreiben(path.join(downloadDir, datei), videoTeile[i]);
        pakete.push({
          datei, bytes, anzahl: videoTeile[i].length, art: 'video',
          titel: videoTeile.length === 1
            ? 'Alle Videos'
            : `Videos – Teil ${i + 1} von ${videoTeile.length}`,
          hinweis: 'Videos und Botschaften aus der Erzählecke.',
        });
      }

      // Ein Paket je Kategorie – der häufigste Wunsch ist „alles von der
      // Trauung", nicht alles überhaupt.
      for (const k of kategorien()) {
        const drin = sichtbar.filter((p) => p.category === k.id);
        if (!drin.length) continue;
        const liste = drin.map(alsEintrag);
        const teile = inTeile(liste);
        for (let i = 0; i < teile.length; i++) {
          bauLauf.schritt = k.name + (teile.length > 1 ? ` (Teil ${i + 1})` : '');
          const datei = teile.length === 1
            ? `hochzeit-${k.id}.zip`
            : `hochzeit-${k.id}-${i + 1}.zip`;
          const bytes = await paketSchreiben(path.join(downloadDir, datei), teile[i]);
          pakete.push({
            datei, bytes, anzahl: teile[i].length, art: 'kategorie',
            kategorie: k.id,
            titel: `${k.icon} ${k.name}` +
              (teile.length > 1 ? ` – Teil ${i + 1} von ${teile.length}` : ''),
            hinweis: 'Nur die Aufnahmen aus dieser Kategorie, in Originalgrösse.',
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

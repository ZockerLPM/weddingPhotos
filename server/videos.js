/* Handy-Versionen von Videos.
 *
 * Warum das nötig ist: Auf iOS führt der einzige Weg in die Fotos-App über
 * die Web-Share-Schnittstelle, und die verlangt die Datei komplett im
 * Speicher. Bei einem 300-MB-Video bricht das Telefon ab. Safaris eigenes
 * Teilen-Menü hilft nicht weiter – es bietet bei Videos nur „In Dateien
 * sichern", nicht „Video sichern".
 *
 * Also muss die Datei kleiner werden. Aus jedem Video entsteht eine
 * zweite Fassung: H.264, höchstens 1080p, ordentlich für die Fotos-App
 * und klein genug, um in einem Zug gesichert zu werden. Das Original
 * bleibt unangetastet und steckt weiterhin in den ZIP-Paketen.
 *
 * Nebeneffekt: Ein HEVC-Video vom iPhone spielt in Chrome oft gar nicht.
 * Die Handy-Version tut es überall.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as db from './db.js';

// Videos unterhalb dieser Grösse lassen sich ohnehin direkt sichern.
const AB_BYTES = Number(process.env.MOBIL_AB_MB || 40) * 1024 * 1024;
const HOEHE = Number(process.env.MOBIL_HOEHE || 1080);
const CRF = Number(process.env.MOBIL_CRF || 26);

const datei = (id, slot, ext) =>
  path.join(db.dirs.photos, `${id}-${slot}.${ext || 'mp4'}`);

let ffmpegDa = null;

// Einmal prüfen, ob ffmpeg überhaupt vorhanden ist. Fehlt es, bleibt die
// Funktion einfach aus – der Rest des Projekts läuft unverändert weiter.
export function ffmpegVorhanden() {
  if (ffmpegDa !== null) return Promise.resolve(ffmpegDa);
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => { ffmpegDa = false; resolve(false); });
    p.on('close', (code) => { ffmpegDa = code === 0; resolve(ffmpegDa); });
  });
}

function umrechnen(quelle, ziel) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-nostdin', '-y',
      '-i', quelle,
      // Höhe begrenzen, Breite gerade halten (H.264 braucht das).
      '-vf', `scale=-2:'min(${HOEHE},ih)'`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', String(CRF),
      '-c:a', 'aac', '-b:a', '128k',
      // faststart: der Player kann sofort loslegen, statt erst das
      // Dateiende zu lesen.
      '-movflags', '+faststart',
      ziel,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let fehler = '';
    p.stderr.on('data', (c) => { fehler = String(c).slice(-400); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg ' + code + ': ' + fehler));
    });
  });
}

let lauf = {
  laeuft: false, fertig: 0, gesamt: 0, schritt: '', fehler: null, moeglich: null,
};
export const status = () => ({ ...lauf });

export async function erzeugen() {
  if (lauf.laeuft) return status();

  const moeglich = await ffmpegVorhanden();
  if (!moeglich) {
    lauf = { ...lauf, moeglich: false, fehler: 'ffmpeg ist nicht installiert' };
    return status();
  }

  const offen = db.ohneMobil().filter((p) => (p.original_bytes || 0) > AB_BYTES);
  lauf = {
    laeuft: true, fertig: 0, gesamt: offen.length,
    schritt: '', fehler: null, moeglich: true,
  };

  (async () => {
    for (const p of offen) {
      const quelle = datei(p.id, 'o', p.ext_original);
      const ziel = datei(p.id, 'm', 'mp4');
      lauf.schritt = `${p.uploader} · ${Math.round((p.original_bytes || 0) / 1048576)} MB`;
      try {
        await fsp.unlink(ziel).catch(() => {});
        await umrechnen(quelle, ziel);
        const bytes = fs.statSync(ziel).size;
        // Wird sie nicht kleiner, bringt sie nichts – dann lieber weg.
        if (bytes >= (p.original_bytes || 0)) {
          await fsp.unlink(ziel).catch(() => {});
          db.setMobile(p.id, 0);
        } else {
          db.setMobile(p.id, bytes);
          console.log('[handyversion] %s  %s MB -> %s MB', p.id,
            Math.round((p.original_bytes || 0) / 1048576),
            Math.round(bytes / 1048576));
        }
      } catch (e) {
        console.warn('[handyversion] %s fehlgeschlagen: %s', p.id, e.message);
      }
      lauf.fertig++;
    }
    lauf.laeuft = false;
    lauf.schritt = 'fertig';
  })();

  return status();
}

// Wie viele Videos hätten gern eine Handy-Version?
export function offeneAnzahl() {
  return db.ohneMobil().filter((p) => (p.original_bytes || 0) > AB_BYTES).length;
}

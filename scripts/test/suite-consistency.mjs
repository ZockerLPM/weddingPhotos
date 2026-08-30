/* Datenbank und Dateien muessen zusammenpassen.
 *
 * Hintergrund: Frueher wurden Anzeigebild und Vorschau direkt nach photos/
 * geschrieben und der Datenbankeintrag danach angelegt. Schlug der Eintrag
 * fehl - etwa weil zwei Wiederholversuche mit derselben clientId
 * gleichzeitig ankamen -, blieben die Dateien ohne Eintrag liegen: voll auf
 * der Platte, aber unsichtbar in Fotowand, Moderation und Galerie.
 */
import fs from 'node:fs';
import path from 'node:path';
import { JPEG, wait, uploadPhoto, modFetch } from './helpers.mjs';

export const name = 'Datenbestand';

function dateienNachId(dataDir) {
  const dir = path.join(dataDir, 'photos');
  let namen = [];
  try { namen = fs.readdirSync(dir); } catch { /* noch leer */ }
  const map = new Map();
  for (const name of namen) {
    const m = /^([0-9A-Z]{26})-([dto])\.([a-z0-9]{1,5})$/i.exec(name);
    if (!m) continue;
    if (!map.has(m[1])) map.set(m[1], {});
    map.get(m[1])[m[2]] = name;
  }
  return map;
}

// Zwei gleichzeitige Uploads mit derselben clientId - der Netz-Retry-Fall.
function gleichzeitig(base, clientId) {
  const bauen = () => {
    const f = new FormData();
    f.append('clientId', clientId);
    f.append('uploader', 'Doppelt');
    f.append('kind', 'photo');
    f.append('takenAt', String(Date.now()));
    f.append('display', new Blob([JPEG], { type: 'image/jpeg' }), 'd.jpg');
    f.append('thumb', new Blob([JPEG], { type: 'image/jpeg' }), 't.jpg');
    return fetch(base + '/api/upload', { method: 'POST', body: f });
  };
  return Promise.all([bauen(), bauen(), bauen()]);
}

export default async function run({ base, key, ok, dataDir }) {
  // --- Wettlauf: dieselbe clientId dreimal parallel
  const antworten = await gleichzeitig(base, 'wettlauf-1');
  const koerper = await Promise.all(antworten.map((r) => r.json()));

  ok('Alle gleichzeitigen Versuche werden beantwortet',
    antworten.every((r) => r.status === 200),
    antworten.map((r) => r.status).join(','));
  const ids = new Set(koerper.map((b) => b.id));
  ok('Sie liefern alle dieselbe Foto-ID', ids.size === 1, [...ids].join(', '));

  await wait(300);
  const feed = await (await fetch(base + '/api/feed')).json();
  const treffer = feed.photos.filter((p) => p.uploader === 'Doppelt');
  ok('Es entsteht genau ein Eintrag', treffer.length === 1, 'n=' + treffer.length);

  // --- Kern der Sache: keine Datei ohne Eintrag
  const dateien = dateienNachId(dataDir);
  const bekannt = new Set(feed.photos.map((p) => p.id));
  const verwaist = [...dateien.keys()].filter((id) => !bekannt.has(id));
  ok('Keine verwaisten Dateien nach dem Wettlauf', verwaist.length === 0,
    verwaist.join(', '));

  // --- tmp bleibt sauber
  let tmp = [];
  try { tmp = fs.readdirSync(path.join(dataDir, 'tmp')); } catch { /* egal */ }
  ok('Keine Reste im tmp-Verzeichnis', tmp.length === 0, tmp.join(', '));

  // --- Jeder Eintrag hat seine beiden Bilder
  const ohneBild = feed.photos.filter((p) => {
    const d = dateien.get(p.id) || {};
    return !d.d || !d.t;
  });
  ok('Jeder Eintrag hat Anzeigebild und Vorschau', ohneBild.length === 0,
    ohneBild.map((p) => p.id).join(', '));

  // --- Original: Eintrag und Datei muessen zusammen passen
  const einzeln = await uploadPhoto(base, { who: 'Originaltest' });
  const fo = new FormData();
  fo.append('original', new Blob([JPEG], { type: 'image/jpeg' }), 'IMG_1.JPG');
  await fetch(`${base}/api/original/${einzeln.body.id}`, { method: 'POST', body: fo });
  await wait(150);

  const feed2 = await (await fetch(base + '/api/feed')).json();
  const p2 = feed2.photos.find((p) => p.id === einzeln.body.id);
  const d2 = dateienNachId(dataDir).get(einzeln.body.id) || {};
  ok('Original ist verknüpft und liegt auf der Platte',
    p2?.hasOriginal === true && !!d2.o, 'hasOriginal=' + p2?.hasOriginal + ' Datei=' + d2.o);

  // --- Moderation zeigt alles und meldet die Gesamtzahl
  const mod = await (await fetch(base + '/api/mod/list?limit=2000',
    { headers: { 'x-mod-key': key } })).json();
  ok('Moderation meldet die Gesamtzahl', typeof mod.total === 'number', 'total=' + mod.total);
  ok('Moderation zeigt alle Einträge', mod.photos.length === mod.total,
    mod.photos.length + ' von ' + mod.total);

  // --- Alles Sichtbare landet auch im ZIP
  await modFetch(base, key, '/api/mod/gallery', { open: true });
  const zip = await fetch(base + '/api/gallery/zip');
  const roh = Buffer.from(await zip.arrayBuffer());
  // Jeder Eintrag im ZIP beginnt mit der lokalen Signatur PK\x03\x04
  let eintraege = 0;
  for (let i = 0; i + 4 <= roh.length; i++) {
    if (roh[i] === 0x50 && roh[i + 1] === 0x4b && roh[i + 2] === 0x03 && roh[i + 3] === 0x04) {
      eintraege++;
    }
  }
  ok('ZIP enthält alle sichtbaren Fotos',
    eintraege === feed2.photos.length,
    eintraege + ' im ZIP, ' + feed2.photos.length + ' sichtbar');
  await modFetch(base, key, '/api/mod/gallery', { open: false });

  await grosserBestand({ base, key, ok });
}

/* Grosse Bestaende duerfen nicht stillschweigend abgeschnitten werden.
 *
 * Genau das passierte: Die Moderation forderte 500 Zeilen an, bei 871 Fotos
 * fehlten also 371 - ohne jeden Hinweis. Sichtbar wurde es nur daran, dass
 * die angezeigte Zahl nicht zur Datenbank passte.
 */
export async function grosserBestand({ base, key, ok }) {
  const ZIEL = 520;                       // knapp ueber der alten Grenze
  const vorher = (await (await fetch(base + '/api/feed')).json()).count;
  const fehlen = ZIEL - vorher;

  // In Schueben hochladen, sonst dauert der Test unnoetig lange.
  for (let i = 0; i < fehlen; i += 40) {
    const schub = [];
    for (let k = 0; k < Math.min(40, fehlen - i); k++) {
      schub.push(uploadPhoto(base, { who: 'Masse' + ((i + k) % 7) }));
    }
    await Promise.all(schub);
  }
  await wait(300);

  const feed = await (await fetch(base + '/api/feed')).json();
  ok('Feed liefert alle Fotos (Fotowand und Galerie)',
    feed.count >= ZIEL, feed.count + ' von mindestens ' + ZIEL);

  const mod = await (await fetch(base + '/api/mod/list?limit=2000',
    { headers: { 'x-mod-key': key } })).json();
  ok('Moderation liefert auch jenseits von 500 alle Einträge',
    mod.photos.length === mod.total && mod.total >= ZIEL,
    mod.photos.length + ' geliefert, ' + mod.total + ' vorhanden');

  // Und wenn doch gekuerzt wird, muss es auffallen.
  const kurz = await (await fetch(base + '/api/mod/list?limit=100',
    { headers: { 'x-mod-key': key } })).json();
  ok('Eine Kürzung ist an total/shown erkennbar',
    kurz.photos.length === 100 && kurz.total > 100,
    kurz.photos.length + ' von ' + kurz.total);
}

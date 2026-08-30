/* Nachbereitung nach der Feier: Serien, Duplikate, Favoriten,
 * Download-Pakete und endgueltiges Loeschen.
 */
import fs from 'node:fs';
import path from 'node:path';
import { JPEG, wait, uploadPhoto, modFetch } from './helpers.mjs';

export const name = 'Nachbereitung';

const modGet = (base, key, pfad) =>
  fetch(base + pfad, { headers: { 'x-mod-key': key } }).then((r) => r.json());

// Original mit vorgegebenem Inhalt nachreichen - fuer die Duplikatsuche.
async function original(base, id, inhalt, name = 'IMG.JPG') {
  const f = new FormData();
  f.append('original', new Blob([inhalt], { type: 'image/jpeg' }), name);
  return fetch(`${base}/api/original/${id}`, { method: 'POST', body: f });
}

export default async function run({ base, key, ok, dataDir }) {
  const t0 = Date.now() - 2 * 3600 * 1000;

  // --- Eine Serie: vier Aufnahmen desselben Gasts in sechs Sekunden
  const serie = [];
  for (let i = 0; i < 4; i++) {
    serie.push((await uploadPhoto(base,
      { who: 'Serienfotograf', takenAt: t0 + i * 2000 })).body.id);
  }
  // Derselbe Gast, aber deutlich spaeter -> gehoert nicht zur Serie
  const spaeter = (await uploadPhoto(base,
    { who: 'Serienfotograf', takenAt: t0 + 600000 })).body.id;
  // Anderer Gast zur selben Zeit -> ebenfalls eigene Gruppe
  await uploadPhoto(base, { who: 'Anders', takenAt: t0 + 1000 });
  await wait(200);

  const s = await modGet(base, key, '/api/mod/serien');
  const gefunden = (s.serien || []).find((g) => g.uploader === 'Serienfotograf');
  ok('Serie wird erkannt', !!gefunden && gefunden.ids.length === 4,
    'gefunden: ' + JSON.stringify(gefunden && gefunden.ids.length));
  ok('Spätere Aufnahme gehört nicht dazu',
    !!gefunden && !gefunden.ids.includes(spaeter));
  ok('Zeitspanne wird mitgeliefert', !!gefunden && gefunden.sekunden === 6,
    'sekunden=' + (gefunden && gefunden.sekunden));
  ok('Einzelaufnahmen bilden keine Gruppe',
    !(s.serien || []).some((g) => g.ids.length < 2));

  // --- Mehrere auf einmal ausblenden
  const weg = gefunden.ids.slice(1);
  const bulk = await (await modFetch(base, key, '/api/mod/hide-many',
    { ids: weg, hidden: true })).json();
  ok('Mehrere lassen sich auf einmal ausblenden', bulk.geaendert === weg.length,
    bulk.geaendert + ' von ' + weg.length);
  await wait(200);
  const nachBulk = await (await fetch(base + '/api/feed')).json();
  ok('Die ausgeblendeten verschwinden aus dem Feed',
    !nachBulk.photos.some((p) => weg.includes(p.id)));

  // --- Duplikate: zwei identische Originale, eines abweichend
  const gleichA = (await uploadPhoto(base, { who: 'Doppelgast' })).body.id;
  const gleichB = (await uploadPhoto(base, { who: 'Doppelgast' })).body.id;
  const anders = (await uploadPhoto(base, { who: 'Doppelgast' })).body.id;
  const inhalt = Buffer.concat([JPEG, Buffer.alloc(4096, 0x5a)]);
  await original(base, gleichA, inhalt);
  await original(base, gleichB, inhalt);
  await original(base, anders, Buffer.concat([JPEG, Buffer.alloc(4096, 0x11)]));
  await wait(200);

  await modFetch(base, key, '/api/mod/hashes', {});
  for (let i = 0; i < 40; i++) {
    const st = await modGet(base, key, '/api/mod/hashes');
    if (!st.laeuft) break;
    await wait(200);
  }

  const dup = await modGet(base, key, '/api/mod/duplikate');
  const gruppe = (dup.gruppen || []).find(
    (g) => g.behalten === gleichA || g.weg.includes(gleichA));
  ok('Identische Dateien werden als Gruppe erkannt', !!gruppe,
    JSON.stringify(dup.gruppen || []));
  ok('Die Gruppe umfasst genau die beiden gleichen',
    !!gruppe && gruppe.weg.length === 1 &&
    [gruppe.behalten, ...gruppe.weg].sort().join() === [gleichA, gleichB].sort().join());
  ok('Das ältere wird zum Behalten vorgeschlagen',
    !!gruppe && gruppe.behalten === gleichA);
  ok('Die abweichende Datei ist nicht dabei',
    !(dup.gruppen || []).some((g) =>
      g.behalten === anders || g.weg.includes(anders)));

  // --- Favoriten
  const fav = await (await modFetch(base, key, '/api/mod/favorite',
    { id: anders, favorite: true })).json();
  ok('Favorit lässt sich setzen', fav.photo.favorite === true);
  await wait(150);
  const feedFav = await (await fetch(base + '/api/feed')).json();
  ok('Favorit steht im Feed für die Galerie',
    feedFav.photos.find((p) => p.id === anders)?.favorite === true);
  const zurueck = await (await modFetch(base, key, '/api/mod/favorite',
    { id: anders, favorite: false })).json();
  ok('Favorit lässt sich wieder aufheben', zurueck.photo.favorite === false);
  await modFetch(base, key, '/api/mod/favorite', { id: anders, favorite: true });

  // --- ZIP nach Gast und Art
  await modFetch(base, key, '/api/mod/gallery', { open: true });

  const zaehleEintraege = (buf) => {
    let n = 0;
    for (let i = 0; i + 4 <= buf.length; i++) {
      if (buf[i] === 0x50 && buf[i + 1] === 0x4b &&
          buf[i + 2] === 0x03 && buf[i + 3] === 0x04) n++;
    }
    return n;
  };

  const proGast = await fetch(base + '/api/gallery/zip?gast=Doppelgast');
  const gastBuf = Buffer.from(await proGast.arrayBuffer());
  const erwartet = feedFav.photos.filter((p) => p.uploader === 'Doppelgast').length;
  ok('ZIP je Gast enthält nur dessen Fotos',
    zaehleEintraege(gastBuf) === erwartet,
    zaehleEintraege(gastBuf) + ' statt ' + erwartet);
  ok('Der Dateiname nennt den Gast',
    /filename="hochzeit-Doppelgast\.zip"/.test(
      proGast.headers.get('content-disposition') || ''),
    proGast.headers.get('content-disposition'));

  const nurFav = await fetch(base + '/api/gallery/zip?art=favoriten');
  ok('ZIP der Favoriten enthält genau die markierten',
    zaehleEintraege(Buffer.from(await nurFav.arrayBuffer())) === 1);

  // --- Download-Pakete bauen
  await modFetch(base, key, '/api/mod/downloads', {});
  let bau = null;
  for (let i = 0; i < 60; i++) {
    bau = await modGet(base, key, '/api/mod/downloads');
    if (!bau.laeuft) break;
    await wait(250);
  }
  ok('Paketbau läuft ohne Fehler durch', !bau.laeuft && !bau.fehler,
    JSON.stringify({ laeuft: bau.laeuft, fehler: bau.fehler }));

  const pakete = (bau.pakete && bau.pakete.pakete) || [];
  ok('Es entstehen Pakete', pakete.length > 0, 'n=' + pakete.length);
  ok('Die kleine Version ist dabei', pakete.some((p) => p.art === 'klein'));
  ok('Jedes Paket hat Titel, Anzahl und Grösse',
    pakete.every((p) => p.titel && p.anzahl > 0 && p.bytes > 0));

  const aufPlatte = fs.readdirSync(path.join(dataDir, 'downloads'));
  ok('Die Dateien liegen wirklich auf der Platte',
    pakete.every((p) => aufPlatte.includes(p.datei)),
    aufPlatte.join(', '));

  // --- Ausliefern: Laengenangabe und Bereichsanfragen (fortsetzbar)
  const klein = pakete.find((p) => p.art === 'klein');
  const kopf = await fetch(base + '/d/' + klein.datei);
  ok('Paket wird mit Längenangabe ausgeliefert',
    Number(kopf.headers.get('content-length')) === klein.bytes,
    kopf.headers.get('content-length') + ' statt ' + klein.bytes);

  const teil = await fetch(base + '/d/' + klein.datei, {
    headers: { Range: 'bytes=10-99' },
  });
  ok('Abgebrochene Downloads lassen sich fortsetzen (Range)',
    teil.status === 206 && Number(teil.headers.get('content-length')) === 90,
    'Status ' + teil.status + ', Länge ' + teil.headers.get('content-length'));

  // --- Bei geschlossener Galerie sind die Pakete gesperrt
  await modFetch(base, key, '/api/mod/gallery', { open: false });
  ok('Bei geschlossener Galerie sind die Pakete gesperrt',
    (await fetch(base + '/d/' + klein.datei)).status === 403);
  ok('Die Paketliste ist ebenfalls gesperrt',
    (await fetch(base + '/api/gallery/downloads')).status === 403);
  await modFetch(base, key, '/api/mod/gallery', { open: true });

  // --- Endgültiges Löschen
  const vorher = await modGet(base, key, '/api/mod/list?limit=2000');
  const verstecktVorher = vorher.photos.filter((p) => p.hidden).length;
  ok('Es gibt etwas zu löschen', verstecktVorher > 0, 'n=' + verstecktVorher);

  ok('Ohne Bestätigungswort wird nicht gelöscht',
    (await modFetch(base, key, '/api/mod/loeschen', { bestaetigung: 'nein' })).status === 400);

  const geloescht = await (await modFetch(base, key, '/api/mod/loeschen',
    { bestaetigung: 'LOESCHEN' })).json();
  ok('Ausgeblendete werden entfernt', geloescht.eintraege === verstecktVorher,
    geloescht.eintraege + ' von ' + verstecktVorher);
  ok('Ihre Dateien verschwinden mit', geloescht.dateien >= verstecktVorher * 2,
    geloescht.dateien + ' Dateien');

  const nachher = await modGet(base, key, '/api/mod/list?limit=2000');
  ok('Danach ist nichts mehr ausgeblendet',
    nachher.photos.filter((p) => p.hidden).length === 0);

  // Und die Dateien sind tatsaechlich weg - keine Leichen im Verzeichnis.
  const bilder = fs.readdirSync(path.join(dataDir, 'photos'));
  const bekannt = new Set(nachher.photos.map((p) => p.id));
  const leichen = bilder.filter((n) => {
    const m = /^([0-9A-Z]{26})-/i.exec(n);
    return m && !bekannt.has(m[1]);
  });
  ok('Keine verwaisten Dateien nach dem Löschen', leichen.length === 0,
    leichen.slice(0, 5).join(', '));

  await modFetch(base, key, '/api/mod/gallery', { open: false });
  await nachreichen({ base, key, ok, dataDir });
  await sichten({ base, key, ok });
  await verlauf({ base, key, ok });
  await feinschliff({ base, key, ok });
  await datumUndListe({ base, key, ok });
  await abgehaktZurueck({ base, key, ok });
}

/* Grosse Originale nachreichen.
 *
 * Der Weg muss auch fuer Dateien funktionieren, die das normale
 * Upload-Limit sprengen - genau dafuer ist er da.
 */
export async function nachreichen({ base, key, ok, dataDir }) {
  const modGet2 = (pfad) =>
    fetch(base + pfad, { headers: { 'x-mod-key': key } }).then((r) => r.json());

  // Ein Video, dessen Original am Fest nicht durchkam.
  const p = await uploadPhoto(base, { who: 'Filmerin', kind: 'video' });
  await wait(150);

  const offen = await modGet2('/api/mod/fehlende-originale');
  ok('Fehlendes Original steht in der Liste',
    offen.eintraege.some((e) => e.id === p.body.id),
    'n=' + offen.eintraege.length);

  // Absichtlich groesser als das Multer-Limit fuer den normalen Upload
  // (512 MB waeren im Test zu langsam - 20 MB in 8-MB-Stuecken zeigt
  // dasselbe Verhalten: mehrere Stuecke, zusammengesetzt).
  const gross = Buffer.alloc(20 * 1024 * 1024);
  for (let i = 0; i < gross.length; i += 4096) gross[i] = i % 251;

  const start = await (await modFetch(base, key, '/api/mod/nachreichen/start',
    { id: p.body.id, dateiname: 'GROSS.MOV' })).json();
  ok('Nachreichen lässt sich starten', !!start.marke && start.ext === 'mov',
    JSON.stringify(start));

  const TEIL = 8 * 1024 * 1024;
  let stuecke = 0;
  for (let pos = 0; pos < gross.length; pos += TEIL) {
    const r = await fetch(
      base + '/api/mod/nachreichen/teil?marke=' + encodeURIComponent(start.marke), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'x-mod-key': key },
        body: gross.subarray(pos, Math.min(pos + TEIL, gross.length)),
      });
    if (r.ok) stuecke++;
  }
  ok('Alle Stücke werden angenommen', stuecke === 3, stuecke + ' von 3');

  const fertig = await (await modFetch(base, key, '/api/mod/nachreichen/fertig',
    { marke: start.marke })).json();
  ok('Abschluss meldet die volle Grösse', fertig.bytes === gross.length,
    fertig.bytes + ' statt ' + gross.length);
  ok('Der Eintrag gilt jetzt als vollständig', fertig.photo.hasOriginal === true);
  ok('Die Endung stammt aus dem Dateinamen', fertig.photo.ext === 'mov');

  // Inhalt muss byte-genau stimmen - sonst waere die Datei unbrauchbar.
  const datei = fs.readFileSync(
    path.join(dataDir, 'photos', `${p.body.id}-o.mov`));
  ok('Die zusammengesetzte Datei ist unversehrt',
    datei.length === gross.length && datei.equals(gross),
    datei.length + ' Bytes');

  const danach = await modGet2('/api/mod/fehlende-originale');
  ok('Der Eintrag verschwindet aus der Liste',
    !danach.eintraege.some((e) => e.id === p.body.id));

  // Ersetzen mit anderer Endung: die alte Datei darf nicht liegen bleiben.
  const s2 = await (await modFetch(base, key, '/api/mod/nachreichen/start',
    { id: p.body.id, dateiname: 'BESSER.MP4' })).json();
  await fetch(base + '/api/mod/nachreichen/teil?marke=' + encodeURIComponent(s2.marke), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'x-mod-key': key },
    body: Buffer.alloc(1024, 7),
  });
  const ersetzt = await (await modFetch(base, key, '/api/mod/nachreichen/fertig',
    { marke: s2.marke })).json();
  ok('Ersetzen mit anderer Endung klappt', ersetzt.photo.ext === 'mp4');
  ok('Die alte Originaldatei bleibt nicht liegen',
    !fs.existsSync(path.join(dataDir, 'photos', `${p.body.id}-o.mov`)));

  // Fehlerfaelle
  ok('Abgelaufene Marke wird abgewiesen',
    (await fetch(base + '/api/mod/nachreichen/teil?marke=gibtsnicht', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-mod-key': key },
      body: Buffer.alloc(16),
    })).status === 410);

  ok('Unbekannte ID wird abgewiesen',
    (await modFetch(base, key, '/api/mod/nachreichen/start',
      { id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ', dateiname: 'x.mp4' })).status === 404);

  ok('Nachreichen braucht den Schlüssel',
    (await fetch(base + '/api/mod/nachreichen/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.body.id }),
    })).status === 401);

  const leer = await (await modFetch(base, key, '/api/mod/nachreichen/start',
    { id: p.body.id, dateiname: 'leer.mp4' })).json();
  ok('Abschluss ohne Inhalt wird abgewiesen',
    (await modFetch(base, key, '/api/mod/nachreichen/fertig',
      { marke: leer.marke })).status === 400);

  let tmp = [];
  try { tmp = fs.readdirSync(path.join(dataDir, 'tmp')); } catch { /* egal */ }
  ok('Kein Rest im tmp-Verzeichnis', tmp.length === 0, tmp.join(', '));
}

/* Die Sichtungs-Seite und ihr Sammel-Endpunkt. */
export async function sichten({ base, key, ok }) {
  const modGet3 = (pfad) =>
    fetch(base + pfad, { headers: { 'x-mod-key': key } }).then((r) => r.json());

  const seite = await fetch(base + '/sichten');
  const html = await seite.text();
  ok('Seite /sichten lädt', seite.status === 200 && html.includes('siBuehne'));

  const a = await uploadPhoto(base, { who: 'Sichter', takenAt: Date.now() - 60000 });
  const b = await uploadPhoto(base, { who: 'Sichter', takenAt: Date.now() - 30000 });
  await wait(200);

  const vorher = await modGet3('/api/mod/list?limit=5000');
  ok('Neue Aufnahmen gelten als ungesichtet',
    vorher.photos.find((p) => p.id === a.body.id)?.reviewed === false);
  ok('Die Liste meldet die offene Anzahl', typeof vorher.offen === 'number',
    'offen=' + vorher.offen);

  // Behalten: gesichtet, bleibt sichtbar
  const behalten = await (await modFetch(base, key, '/api/mod/sichten',
    { id: a.body.id, reviewed: true, hidden: false })).json();
  ok('Behalten markiert als gesichtet',
    behalten.photo.reviewed === true && behalten.photo.hidden !== true);
  ok('Der Zähler der offenen sinkt', behalten.offen === vorher.offen - 1,
    behalten.offen + ' statt ' + (vorher.offen - 1));

  // Aussortieren: gesichtet und ausgeblendet, in einem Zug
  const weg = await (await modFetch(base, key, '/api/mod/sichten',
    { id: b.body.id, reviewed: true, hidden: true })).json();
  ok('Aussortieren blendet aus und markiert', weg.photo.reviewed === true);
  await wait(200);
  const feed = await (await fetch(base + '/api/feed')).json();
  ok('Das Aussortierte verschwindet aus der Galerie',
    !feed.photos.some((p) => p.id === b.body.id));

  // Favorit und Kategorie über denselben Endpunkt
  const fav = await (await modFetch(base, key, '/api/mod/sichten',
    { id: a.body.id, favorite: true, category: 'trauung' })).json();
  ok('Favorit und Kategorie in einem Zug',
    fav.photo.favorite === true && fav.photo.category === 'trauung');

  // Rückgängig: alter Zustand wird wiederhergestellt
  const zurueck = await (await modFetch(base, key, '/api/mod/sichten',
    { id: b.body.id, reviewed: false, hidden: false })).json();
  ok('Rückgängig stellt den alten Zustand her',
    zurueck.photo.reviewed === false && zurueck.photo.hidden !== true);

  // Nur mitgeschickte Felder werden angefasst
  const nurFav = await (await modFetch(base, key, '/api/mod/sichten',
    { id: a.body.id, favorite: false })).json();
  ok('Nicht mitgeschickte Felder bleiben unberührt',
    nurFav.photo.category === 'trauung' && nurFav.photo.reviewed === true);

  ok('Unbekannte Kategorie wird abgewiesen',
    (await modFetch(base, key, '/api/mod/sichten',
      { id: a.body.id, category: 'gibtsnicht' })).status === 400);
  ok('Unbekannte ID wird abgewiesen',
    (await modFetch(base, key, '/api/mod/sichten',
      { id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ', reviewed: true })).status === 404);
  ok('Sichten braucht den Schlüssel',
    (await fetch(base + '/api/mod/sichten', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: a.body.id, reviewed: true }),
    })).status === 401);
}

/* Verlauf und Protokollierung. */
export async function verlauf({ base, key, ok }) {
  const vorher = await (await fetch(base + '/api/mod/verlauf?limit=5',
    { headers: { 'x-mod-key': key } })).json();
  ok('Verlauf ist abrufbar', Array.isArray(vorher.zeilen),
    JSON.stringify(vorher).slice(0, 80));

  const p = await uploadPhoto(base, { who: 'Chronist', kind: 'video' });
  await wait(200);

  const d = await (await fetch(base + '/api/mod/verlauf?limit=50',
    { headers: { 'x-mod-key': key } })).json();
  const eintrag = d.zeilen.find((z) => z.id === p.body.id);
  ok('Der Upload steht im Verlauf', !!eintrag && eintrag.art === 'photo');
  ok('Mit Name und Art', eintrag?.wer === 'Chronist' && eintrag?.kind === 'video');
  ok('Neueste zuerst', d.zeilen[0].seq >= d.zeilen[d.zeilen.length - 1].seq);
  ok('Die Gesamtzahl wird gemeldet', typeof d.gesamt === 'number' && d.gesamt > 0);

  await modFetch(base, key, '/api/mod/hide', { id: p.body.id, hidden: true });
  await wait(200);
  const d2 = await (await fetch(base + '/api/mod/verlauf?limit=50',
    { headers: { 'x-mod-key': key } })).json();
  ok('Auch das Ausblenden wird festgehalten',
    d2.zeilen.some((z) => z.art === 'hide' && z.id === p.body.id && z.hidden === true));
  await modFetch(base, key, '/api/mod/hide', { id: p.body.id, hidden: false });

  ok('Verlauf braucht den Schlüssel',
    (await fetch(base + '/api/mod/verlauf')).status === 401);

  const gross = await (await fetch(base + '/api/mod/verlauf?limit=99999',
    { headers: { 'x-mod-key': key } })).json();
  ok('Die Menge ist begrenzt', gross.zeilen.length <= 1000);
}

/* Handy-Versionen, „kein Original" und die Paket-Vorschau. */
export async function feinschliff({ base, key, ok }) {
  const modGet4 = (pfad) =>
    fetch(base + pfad, { headers: { 'x-mod-key': key } }).then((r) => r.json());

  // --- „Kein Original vorhanden/gewünscht"
  const p = await uploadPhoto(base, { who: 'Ohnedatei', kind: 'video' });
  await wait(150);

  let liste = await modGet4('/api/mod/fehlende-originale');
  ok('Der Eintrag steht auf der Nachreichliste',
    liste.eintraege.some((e) => e.id === p.body.id));
  ok('Die Liste meldet die abgehakten mit',
    typeof liste.uebersprungen === 'number');

  const abgehakt = await (await modFetch(base, key, '/api/mod/kein-original',
    { id: p.body.id, skip: true })).json();
  ok('„Kein Original" lässt sich setzen', abgehakt.photo.ohneOriginal === true);

  liste = await modGet4('/api/mod/fehlende-originale');
  ok('Danach verschwindet er von der Liste',
    !liste.eintraege.some((e) => e.id === p.body.id));
  ok('Und wird als abgehakt gezählt', liste.uebersprungen >= 1);

  const zurueck = await (await modFetch(base, key, '/api/mod/kein-original',
    { id: p.body.id, skip: false })).json();
  ok('Es lässt sich zurücknehmen', zurueck.photo.ohneOriginal === false);
  liste = await modGet4('/api/mod/fehlende-originale');
  ok('Dann steht er wieder auf der Liste',
    liste.eintraege.some((e) => e.id === p.body.id));

  ok('Unbekannte ID wird abgewiesen',
    (await modFetch(base, key, '/api/mod/kein-original',
      { id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' })).status === 404);
  ok('Braucht den Schlüssel',
    (await fetch(base + '/api/mod/kein-original', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.body.id }),
    })).status === 401);

  // --- Handy-Versionen (ffmpeg ist im Testumfeld meist nicht da)
  const handy = await modGet4('/api/mod/handyversionen');
  ok('Handy-Versionen melden ihren Stand',
    typeof handy.moeglich === 'boolean' && typeof handy.offen === 'number',
    JSON.stringify(handy));
  const start = await (await modFetch(base, key, '/api/mod/handyversionen', {})).json();
  ok('Ohne ffmpeg wird sauber abgelehnt statt abzustürzen',
    start.moeglich === true || (start.moeglich === false && !!start.fehler),
    JSON.stringify(start));
  ok('Handy-Versionen brauchen den Schlüssel',
    (await fetch(base + '/api/mod/handyversionen')).status === 401);

  // --- Vorschau der Pakete
  const v = await modGet4('/api/mod/downloads/vorschau');
  ok('Vorschau liefert Pakete', Array.isArray(v.pakete) && v.pakete.length > 0,
    'n=' + (v.pakete || []).length);
  ok('Mit Anzahl und Grösse',
    v.pakete.every((x) => x.anzahl > 0 && typeof x.bytes === 'number'));
  ok('Und einer Gesamtsumme',
    typeof v.gesamt === 'number' && typeof v.dateien === 'number');
  ok('Ohne dass etwas gebaut wurde',
    (await modGet4('/api/mod/downloads')).laeuft === false);

  // Die Teilgrösse wirkt sich aus.
  const klein = await modGet4('/api/mod/downloads/vorschau?teilMB=100');
  const gross = await modGet4('/api/mod/downloads/vorschau?teilMB=8000');
  ok('Kleinere Teile ergeben mehr Pakete',
    klein.pakete.length >= gross.pakete.length,
    klein.pakete.length + ' vs ' + gross.pakete.length);

  // --- Auswahl beim Bau wird beachtet
  const nurKlein = await (await modFetch(base, key, '/api/mod/downloads',
    { klein: true, fotos: false, videos: false, kategorien: false })).json();
  ok('Bau mit Auswahl startet', nurKlein.laeuft === true || !!nurKlein.pakete);
  let bau = null;
  for (let i = 0; i < 60; i++) {
    bau = await modGet4('/api/mod/downloads');
    if (!bau.laeuft) break;
    await wait(250);
  }
  const gebaut = (bau.pakete && bau.pakete.pakete) || [];
  ok('Es entsteht nur die kleine Version',
    gebaut.length > 0 && gebaut.every((x) => x.art === 'klein'),
    gebaut.map((x) => x.art).join(', '));

  ok('Vorschau braucht den Schlüssel',
    (await fetch(base + '/api/mod/downloads/vorschau')).status === 401);
}

/* Datumskorrektur und der Zugriff auf abgehakte Einträge. */
export async function datumUndListe({ base, key, ok }) {
  const modGet5 = (pfad) =>
    fetch(base + pfad, { headers: { 'x-mod-key': key } }).then((r) => r.json());

  // Drei Aufnahmen am „Hochzeitstag", eine irrtümlich von heute.
  const tag = new Date();
  tag.setDate(tag.getDate() - 14);
  tag.setHours(20, 0, 0, 0);
  const amTag = [];
  for (let i = 0; i < 3; i++) {
    amTag.push((await uploadPhoto(base, {
      who: 'Datumstest', takenAt: tag.getTime() + i * 60000,
    })).body.id);
  }
  // Ohne brauchbares Datum -> landet auf heute und gilt als Altfoto.
  const falsch = (await uploadPhoto(base,
    { who: 'Datumstest', takenAt: 0 })).body.id;
  await wait(250);

  const uebersicht = await modGet5('/api/mod/datum');
  ok('Tagesübersicht wird geliefert',
    Array.isArray(uebersicht.tage) && uebersicht.tage.length >= 1,
    JSON.stringify((uebersicht.tage || []).map((t) => t.tag)));
  ok('Sie nennt einen Vorschlag für den Hochzeitstag', !!uebersicht.vorschlag);
  ok('Und den heutigen Tag', /^\d{4}-\d{2}-\d{2}$/.test(uebersicht.heute));

  const zielTag = [
    tag.getFullYear(),
    String(tag.getMonth() + 1).padStart(2, '0'),
    String(tag.getDate()).padStart(2, '0'),
  ].join('-');

  // Die eine falsche Aufnahme gezielt verschieben, Uhrzeit behalten.
  let feed = await (await fetch(base + '/api/feed')).json();
  const vorher = feed.photos.find((p) => p.id === falsch);
  const alteStunde = new Date(vorher.effectiveAt).getHours();

  const r = await (await modFetch(base, key, '/api/mod/datum', {
    ids: [falsch], tag: zielTag, uhrzeitBehalten: true, alsAbend: true,
  })).json();
  ok('Verschieben meldet die Anzahl', r.geaendert === 1, JSON.stringify(r));

  await wait(200);
  feed = await (await fetch(base + '/api/feed')).json();
  const nachher = feed.photos.find((p) => p.id === falsch);
  const d = new Date(nachher.effectiveAt);
  ok('Der Tag stimmt jetzt',
    d.getFullYear() === tag.getFullYear() && d.getDate() === tag.getDate(),
    d.toISOString());
  ok('Die Uhrzeit blieb erhalten', d.getHours() === alteStunde,
    d.getHours() + ' statt ' + alteStunde);
  ok('Es gilt nicht mehr als Altfoto', nachher.archive === false);
  ok('Das ursprüngliche Aufnahmedatum bleibt unangetastet',
    nachher.takenAt === vorher.takenAt);

  ok('Ungültiges Datum wird abgewiesen',
    (await modFetch(base, key, '/api/mod/datum', { tag: 'Freitag' })).status === 400);
  ok('Ohne Quelle wird abgewiesen',
    (await modFetch(base, key, '/api/mod/datum', { tag: zielTag })).status === 400);
  ok('Datumskorrektur braucht den Schlüssel',
    (await fetch(base + '/api/mod/datum')).status === 401);

  // --- Abgehakte Einträge bleiben erreichbar
  const p = await uploadPhoto(base, { who: 'Abgehakt', kind: 'video' });
  await wait(150);
  await modFetch(base, key, '/api/mod/kein-original', { id: p.body.id, skip: true });

  const nurOffen = await modGet5('/api/mod/fehlende-originale');
  ok('Abgehakte fehlen in der normalen Liste',
    !nurOffen.eintraege.some((e) => e.id === p.body.id));

  const alle = await modGet5('/api/mod/fehlende-originale?alle=1');
  ok('Mit ?alle=1 sind sie wieder dabei',
    alle.eintraege.some((e) => e.id === p.body.id) && alle.zeigtAlle === true);
  ok('Und sind als abgehakt gekennzeichnet',
    alle.eintraege.find((e) => e.id === p.body.id)?.ohneOriginal === true);

  // Ein Original lässt sich trotzdem nachreichen.
  const start = await (await modFetch(base, key, '/api/mod/nachreichen/start',
    { id: p.body.id, dateiname: 'DOCH.MP4' })).json();
  await fetch(base + '/api/mod/nachreichen/teil?marke=' + start.marke, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'x-mod-key': key },
    body: Buffer.alloc(2048, 9),
  });
  const fertig = await (await modFetch(base, key, '/api/mod/nachreichen/fertig',
    { marke: start.marke })).json();
  ok('Auch abgehakte Einträge nehmen ein Original an',
    fertig.photo.hasOriginal === true);
}

/* Der Weg zurück: alles abgehakt, dann taucht doch eine Datei auf.
 *
 * Genau hier hakte es: Ist nichts mehr offen, war die Liste leer – und der
 * Umschalter zu den abgehakten wurde gar nicht erst gezeichnet.
 */
export async function abgehaktZurueck({ base, key, ok }) {
  const modGet6 = (pfad) =>
    fetch(base + pfad, { headers: { 'x-mod-key': key } }).then((r) => r.json());

  // Erst alles offene abhaken, damit die Liste wirklich leer ist.
  let offen = await modGet6('/api/mod/fehlende-originale');
  for (const e of offen.eintraege) {
    await modFetch(base, key, '/api/mod/kein-original', { id: e.id, skip: true });
  }

  offen = await modGet6('/api/mod/fehlende-originale');
  ok('Die offene Liste ist jetzt leer', offen.eintraege.length === 0);
  ok('Die Anzahl der abgehakten wird trotzdem gemeldet',
    offen.uebersprungen > 0, 'uebersprungen=' + offen.uebersprungen);

  const alle = await modGet6('/api/mod/fehlende-originale?alle=1');
  ok('Über ?alle=1 sind sie erreichbar', alle.eintraege.length > 0,
    'n=' + alle.eintraege.length);

  // Für einen davon doch noch ein Original nachreichen.
  const ziel = alle.eintraege[0];
  const start = await (await modFetch(base, key, '/api/mod/nachreichen/start',
    { id: ziel.id, dateiname: 'SPAETER.MP4' })).json();
  ok('Nachreichen startet auch bei abgehakten', !!start.marke);

  await fetch(base + '/api/mod/nachreichen/teil?marke=' + encodeURIComponent(start.marke), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'x-mod-key': key },
    body: Buffer.alloc(3072, 5),
  });
  const fertig = await (await modFetch(base, key, '/api/mod/nachreichen/fertig',
    { marke: start.marke })).json();
  ok('Das Original kommt an', fertig.photo.hasOriginal === true);
  ok('Und „kein Original" ist damit aufgehoben',
    fertig.photo.ohneOriginal === false, JSON.stringify(fertig.photo.ohneOriginal));

  const danach = await modGet6('/api/mod/fehlende-originale?alle=1');
  ok('Der Eintrag verschwindet aus der Fehlliste',
    !danach.eintraege.some((e) => e.id === ziel.id));
  ok('Die Zahl der abgehakten sinkt',
    danach.uebersprungen === offen.uebersprungen - 1,
    danach.uebersprungen + ' statt ' + (offen.uebersprungen - 1));

  // Und der Umschalter im Skript darf nicht hinter einem frühen Ausstieg liegen.
  const js = await (await fetch(base + '/js/mod.js')).text();
  const umschalter = js.indexOf('abgehakten zeigen');
  const ausstieg = js.indexOf("Bei allen offenen Beiträgen liegt das Original vor");
  ok('Der Umschalter wird vor dem Ausstieg gezeichnet',
    umschalter > 0 && ausstieg > 0 && umschalter < ausstieg,
    'Umschalter@' + umschalter + ' Ausstieg@' + ausstieg);
}

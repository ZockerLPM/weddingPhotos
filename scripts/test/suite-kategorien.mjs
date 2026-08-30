/* Kategorien, Auswahl-Downloads und die Galerie-Endpunkte dafuer. */
import { wait, uploadPhoto, modFetch } from './helpers.mjs';

export const name = 'Kategorien & Auswahl';

const modGet = (base, key, pfad) =>
  fetch(base + pfad, { headers: { 'x-mod-key': key } }).then((r) => r.json());

function zipEintraege(buf) {
  let n = 0;
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b &&
        buf[i + 2] === 0x03 && buf[i + 3] === 0x04) n++;
  }
  return n;
}

export default async function run({ base, key, ok }) {
  // --- Standardliste
  const std = await (await fetch(base + '/api/categories')).json();
  ok('Standard-Kategorien werden geliefert', std.kategorien.length >= 8,
    'n=' + std.kategorien.length);
  ok('Trauung ist dabei', std.kategorien.some((k) => k.id === 'trauung'));

  const feed0 = await (await fetch(base + '/api/feed')).json();
  ok('Feed liefert die Kategorien mit', (feed0.kategorien || []).length >= 8);

  // --- Fotos anlegen, verteilt über zwei Zeitfenster
  const t0 = Date.now() - 4 * 3600 * 1000;
  const trauung = [];
  for (let i = 0; i < 4; i++) {
    trauung.push((await uploadPhoto(base,
      { who: 'Anna', takenAt: t0 + i * 60000 })).body.id);
  }
  const essen = [];
  for (let i = 0; i < 3; i++) {
    essen.push((await uploadPhoto(base,
      { who: 'Werner', takenAt: t0 + 7200000 + i * 60000 })).body.id);
  }
  await wait(250);

  // --- Einzelzuweisung über IDs
  const zu = await (await modFetch(base, key, '/api/mod/category',
    { ids: essen, category: 'essen' })).json();
  ok('Kategorie lässt sich mehreren zuweisen', zu.geaendert === essen.length,
    zu.geaendert + ' von ' + essen.length);

  await wait(150);
  let feed = await (await fetch(base + '/api/feed')).json();
  ok('Kategorie steht am Foto im Feed',
    feed.photos.filter((p) => essen.includes(p.id))
      .every((p) => p.category === 'essen'));

  // --- Zuweisung über einen Zeitraum
  const zeit = await (await modFetch(base, key, '/api/mod/category', {
    category: 'trauung',
    von: t0 - 60000,
    bis: t0 + 4 * 60000,
  })).json();
  ok('Zeitraum-Zuweisung greift', zeit.geaendert === trauung.length,
    zeit.geaendert + ' statt ' + trauung.length);

  await wait(150);
  feed = await (await fetch(base + '/api/feed')).json();
  ok('Nur der Zeitraum wurde geändert',
    feed.photos.filter((p) => essen.includes(p.id))
      .every((p) => p.category === 'essen'));
  ok('Die Fotos der Trauung tragen die Kategorie',
    feed.photos.filter((p) => trauung.includes(p.id))
      .every((p) => p.category === 'trauung'));

  ok('Unbekannte Kategorie wird abgelehnt',
    (await modFetch(base, key, '/api/mod/category',
      { ids: essen, category: 'gibtsnicht' })).status === 400);
  ok('Ungültiger Zeitraum wird abgelehnt',
    (await modFetch(base, key, '/api/mod/category',
      { category: 'essen', von: 5000, bis: 1000 })).status === 400);

  // --- Kategorien bearbeiten
  const neu = [
    { id: 'trauung', icon: '💍', name: 'Die Trauung' },   // umbenannt
    { id: '', icon: '🎺', name: 'Musik' },
  ];
  const gespeichert = await (await modFetch(base, key, '/api/mod/categories',
    { kategorien: neu })).json();
  ok('Kategorienliste lässt sich speichern', gespeichert.kategorien.length === 2);
  ok('Bestehende id überlebt das Umbenennen',
    gespeichert.kategorien[0].id === 'trauung' &&
    gespeichert.kategorien[0].name === 'Die Trauung');
  ok('Neue Kategorie bekommt eine id',
    /^[a-z0-9_-]+$/.test(gespeichert.kategorien[1].id));

  await wait(150);
  feed = await (await fetch(base + '/api/feed')).json();
  ok('Zuordnung bleibt trotz Umbenennen erhalten',
    feed.photos.filter((p) => trauung.includes(p.id))
      .every((p) => p.category === 'trauung'));

  const zurueck = await (await modFetch(base, key, '/api/mod/categories/reset', {})).json();
  ok('Zurücksetzen stellt den Standard her', zurueck.kategorien.length >= 8);

  // --- Downloads: Galerie öffnen
  await modFetch(base, key, '/api/mod/gallery', { open: true });

  const katZip = await fetch(base + '/api/gallery/zip?kategorie=essen');
  ok('ZIP je Kategorie enthält nur deren Aufnahmen',
    zipEintraege(Buffer.from(await katZip.arrayBuffer())) === essen.length);
  ok('Der Dateiname nennt die Kategorie',
    /filename="hochzeit-essen\.zip"/.test(katZip.headers.get('content-disposition') || ''),
    katZip.headers.get('content-disposition'));

  // --- Auswahl-Marke für beliebige Zusammenstellungen
  const auswahl = essen.slice(0, 2).concat(trauung.slice(0, 1));
  const marke = await (await fetch(base + '/api/gallery/auswahl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: auswahl }),
  })).json();
  ok('Auswahl lässt sich ablegen', !!marke.marke && marke.anzahl === 3,
    JSON.stringify(marke));

  const auswahlZip = await fetch(
    base + '/api/gallery/zip?auswahl=' + encodeURIComponent(marke.marke));
  ok('ZIP der Auswahl enthält genau die gewählten',
    zipEintraege(Buffer.from(await auswahlZip.arrayBuffer())) === auswahl.length);

  ok('Leere Auswahl wird abgelehnt',
    (await fetch(base + '/api/gallery/auswahl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    })).status === 400);

  // Wichtig: eine abgelaufene Marke darf NICHT stillschweigend die ganze
  // Galerie liefern - wer auf ZIP tippt, bekaeme sonst unerwartet Gigabyte.
  const unbekannt = await fetch(base + '/api/gallery/zip?auswahl=gibtsnicht');
  ok('Abgelaufene Auswahl wird abgewiesen statt alles zu liefern',
    unbekannt.status === 410, 'Status ' + unbekannt.status);
  ok('Die Absage kommt als lesbare Meldung',
    (unbekannt.headers.get('content-type') || '').includes('json'));

  // --- Kategorien in der Download-Liste
  const dl = await (await fetch(base + '/api/gallery/downloads')).json();
  ok('Download-Liste nennt die Kategorien', (dl.kategorien || []).length >= 8);
  ok('Download-Liste nennt die Gäste', (dl.gaeste || []).includes('Anna'));

  // --- Kategorie-Pakete beim Bau
  await modFetch(base, key, '/api/mod/downloads', {});
  let bau = null;
  for (let i = 0; i < 80; i++) {
    bau = await modGet(base, key, '/api/mod/downloads');
    if (!bau.laeuft) break;
    await wait(250);
  }
  ok('Paketbau läuft durch', !bau.laeuft && !bau.fehler, JSON.stringify(bau.fehler));

  const pakete = (bau.pakete && bau.pakete.pakete) || [];
  const katPakete = pakete.filter((p) => p.art === 'kategorie');
  ok('Für jede belegte Kategorie entsteht ein Paket', katPakete.length === 2,
    katPakete.map((p) => p.kategorie).join(', '));
  ok('Das Paket der Trauung enthält die richtige Anzahl',
    katPakete.find((p) => p.kategorie === 'trauung')?.anzahl === trauung.length);

  // --- Bei geschlossener Galerie ist auch die Auswahl gesperrt
  await modFetch(base, key, '/api/mod/gallery', { open: false });
  ok('Auswahl ablegen ist bei geschlossener Galerie gesperrt',
    (await fetch(base + '/api/gallery/auswahl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: auswahl }),
    })).status === 403);

  // --- Galerie-Seite lädt weiterhin
  const seite = await fetch(base + '/galerie');
  const html = await seite.text();
  ok('Galerie-Seite lädt mit Filterleiste und Aktionsleiste',
    seite.status === 200 && html.includes('chipsleiste') && html.includes('aktionen'));

  await gaesteStueckweise({ base, ok });
  await galerieDetails({ base, key, ok });
  await allesKnopf({ base, key, ok });
}

/* Der Gaeste-Weg fuer grosse Originale und seine Grenzen. */
export async function gaesteStueckweise({ base, ok }) {
  const p = await uploadPhoto(base, { who: 'Handyfilmer', kind: 'video' });
  await wait(150);

  const start = await (await fetch(`${base}/api/original/${p.body.id}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dateiname: 'IMG_0042.MOV' }),
  })).json();
  ok('Gäste können ohne Schlüssel stückweise hochladen',
    !!start.marke && start.ext === 'mov', JSON.stringify(start));

  const daten = Buffer.alloc(9000, 0x33);
  const teil = await fetch(
    `${base}/api/original/${p.body.id}/teil?marke=${encodeURIComponent(start.marke)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: daten,
    });
  ok('Ein Stück wird angenommen', teil.status === 200);

  // Eine fremde Marke darf nicht auf einen anderen Beitrag angewendet werden.
  const anderer = await uploadPhoto(base, { who: 'Handyfilmer' });
  const fremd = await fetch(
    `${base}/api/original/${anderer.body.id}/teil?marke=${encodeURIComponent(start.marke)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(16),
    });
  ok('Marke eines anderen Beitrags wird abgewiesen', fremd.status === 400,
    'Status ' + fremd.status);

  const fertig = await (await fetch(`${base}/api/original/${p.body.id}/fertig`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marke: start.marke }),
  })).json();
  ok('Abschluss meldet die Grösse', fertig.bytes === daten.length,
    fertig.bytes + ' statt ' + daten.length);

  await wait(150);
  const feed = await (await fetch(base + '/api/feed')).json();
  ok('Das Original ist verknüpft',
    feed.photos.find((x) => x.id === p.body.id)?.hasOriginal === true);

  // Ein vorhandenes Original darf der Gäste-Weg NICHT überschreiben.
  const nochmal = await (await fetch(`${base}/api/original/${p.body.id}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dateiname: 'ANDERS.MP4' }),
  })).json();
  ok('Vorhandenes Original wird nicht überschrieben', nochmal.existed === true,
    JSON.stringify(nochmal));

  ok('Leeres Stück wird abgewiesen',
    (await fetch(`${base}/api/original/${p.body.id}/teil?marke=x`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(0),
    })).status === 400);

  ok('Unbekannter Beitrag wird abgewiesen',
    (await fetch(`${base}/api/original/01ZZZZZZZZZZZZZZZZZZZZZZZZ/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dateiname: 'x.mp4' }),
    })).status === 404);
}

/* Galerie-Feinheiten: Dateigroesse, Begruessung, Altfoto-Filter. */
export async function galerieDetails({ base, key, ok }) {
  // --- Groesse des Originals muss im Feed stehen. Ohne sie kann die
  //     Galerie nicht VORHER entscheiden, ob ein Video sicherbar ist.
  const p = await uploadPhoto(base, { who: 'Groessentest', kind: 'video' });
  const daten = Buffer.alloc(1234567, 0x41);
  const fo = new FormData();
  fo.append('original', new Blob([daten], { type: 'video/mp4' }), 'CLIP.MP4');
  await fetch(`${base}/api/original/${p.body.id}`, { method: 'POST', body: fo });
  await wait(200);

  let feed = await (await fetch(base + '/api/feed')).json();
  const eintrag = feed.photos.find((x) => x.id === p.body.id);
  ok('Feed nennt die Grösse des Originals', eintrag?.bytes === daten.length,
    eintrag?.bytes + ' statt ' + daten.length);

  // Auch beim stueckweisen Weg muss die Groesse stimmen.
  const p2 = await uploadPhoto(base, { who: 'Groessentest', kind: 'video' });
  const s2 = await (await fetch(`${base}/api/original/${p2.body.id}/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dateiname: 'GROSS.MOV' }),
  })).json();
  await fetch(`${base}/api/original/${p2.body.id}/teil?marke=${s2.marke}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.alloc(65432, 7),
  });
  await fetch(`${base}/api/original/${p2.body.id}/fertig`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marke: s2.marke }),
  });
  await wait(200);
  feed = await (await fetch(base + '/api/feed')).json();
  ok('Auch stückweise Uploads melden die Grösse',
    feed.photos.find((x) => x.id === p2.body.id)?.bytes === 65432);

  ok('Fotos ohne Original melden Grösse 0',
    feed.photos.filter((x) => !x.hasOriginal).every((x) => x.bytes === 0));

  // --- Begruessung
  ok('Standard-Begrüssung wird geliefert',
    !!feed.gruss && feed.gruss.titel.length > 0 && feed.gruss.text.length > 0,
    JSON.stringify(feed.gruss));

  const eigen = await (await modFetch(base, key, '/api/mod/gruss', {
    titel: 'Ihr seid die Besten',
    text: 'Danke für diesen Tag.',
  })).json();
  ok('Eigene Begrüssung lässt sich setzen',
    eigen.gruss.titel === 'Ihr seid die Besten');
  await wait(150);
  feed = await (await fetch(base + '/api/feed')).json();
  ok('Sie steht im Feed', feed.gruss.titel === 'Ihr seid die Besten');

  const zurueck = await (await modFetch(base, key, '/api/mod/gruss',
    { titel: '', text: '' })).json();
  ok('Leeren stellt den Vorschlag wieder her',
    zurueck.gruss.titel !== 'Ihr seid die Besten' && zurueck.gruss.titel.length > 0);

  ok('Begrüssung ändern braucht den Schlüssel',
    (await fetch(base + '/api/mod/gruss', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ titel: 'x' }),
    })).status === 401);

  // --- Altfotos als eigene Auswahl
  const alt = await uploadPhoto(base, {
    who: 'Oma', takenAt: new Date('1998-06-01').getTime(),
  });
  await wait(200);
  feed = await (await fetch(base + '/api/feed')).json();
  ok('Altfoto ist als solches erkannt',
    feed.photos.find((x) => x.id === alt.body.id)?.archive === true);

  await modFetch(base, key, '/api/mod/gallery', { open: true });
  const zip = await fetch(base + '/api/gallery/zip?gast=Oma');
  ok('Altfotos lassen sich einzeln laden', zip.status === 200);
  await modFetch(base, key, '/api/mod/gallery', { open: false });

  // --- Die Galerie-Seite bringt die neuen Bausteine mit
  const html = await (await fetch(base + '/galerie')).text();
  ok('Galerie enthält Begrüssung und Vollbild-Pfeile',
    html.includes('grussTitel') && html.includes('lbpfeil'));
  ok('Vollbild hat einen beschrifteten Download-Knopf',
    html.includes('lbDownload') && html.includes('lbGroesse'));
}

/* Der Alles-Knopf und die Handy-Version in der Galerie. */
export async function allesKnopf({ base, key, ok }) {
  await modFetch(base, key, '/api/mod/gallery', { open: true });

  // Ohne fertige Pakete muss der Knopf trotzdem funktionieren.
  const html = await (await fetch(base + '/galerie')).text();
  ok('Galerie hat den Alles-Knopf',
    html.includes('btnAlles') && html.includes('allesMeta'));

  const alles = await fetch(base + '/api/gallery/zip');
  ok('Alles-ZIP wird ausgeliefert', alles.status === 200);
  const roh = Buffer.from(await alles.arrayBuffer());
  ok('Es ist ein gültiges ZIP', roh[0] === 0x50 && roh[1] === 0x4b);

  // Die Handy-Version steht im Feed, damit die Galerie sie wählen kann.
  const feed = await (await fetch(base + '/api/feed')).json();
  ok('Feed nennt die Handy-Version', feed.photos.every(
    (p) => typeof p.mobilBytes === 'number'));
  ok('Feed nennt „kein Original"', feed.photos.every(
    (p) => typeof p.ohneOriginal === 'boolean'));

  await modFetch(base, key, '/api/mod/gallery', { open: false });
}

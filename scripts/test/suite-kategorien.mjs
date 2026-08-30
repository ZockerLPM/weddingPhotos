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
}

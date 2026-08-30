/* Fotobuch: Bauplan, Einstellungen, Vorschau und ZIP-Export. */
import { JPEG, wait, uploadPhoto, modFetch } from './helpers.mjs';

export const name = 'Fotobuch';

// Die Kapitel kommen seitenweise – für Reihenfolge-Prüfungen wieder
// zu einer Liste zusammenlegen.
const kapitelFotos = (k) =>
  k.seiten.reduce((a, s) => a.concat(s.fotos), []);

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
  const t0 = Date.now() - 3 * 3600 * 1000;

  // Zwei Kategorien, ein Favorit, ein Altfoto – genug für alle Kapitelarten.
  const trauung = [];
  for (let i = 0; i < 6; i++) {
    trauung.push((await uploadPhoto(base,
      { who: 'Anna', takenAt: t0 + i * 60000 })).body.id);
  }
  const essen = [];
  for (let i = 0; i < 4; i++) {
    essen.push((await uploadPhoto(base,
      { who: 'Werner', takenAt: t0 + 3600000 + i * 60000 })).body.id);
  }
  const alt = (await uploadPhoto(base,
    { who: 'Oma', takenAt: new Date('1996-05-05').getTime() })).body.id;
  await wait(300);

  await modFetch(base, key, '/api/mod/category', { ids: trauung, category: 'trauung' });
  await modFetch(base, key, '/api/mod/category', { ids: essen, category: 'essen' });
  await modFetch(base, key, '/api/mod/favorite', { id: trauung[0], favorite: true });
  await wait(200);

  // --- Bauplan
  const plan = await modGet(base, key, '/api/mod/buch');
  ok('Bauplan wird geliefert', Array.isArray(plan.kapitel) && plan.kapitel.length > 0,
    'n=' + (plan.kapitel || []).length);
  ok('Mit Foto- und Seitenzahl',
    typeof plan.fotos === 'number' && typeof plan.seiten === 'number',
    plan.fotos + ' / ' + plan.seiten);

  const titel = plan.kapitel.map((k) => k.titel);
  ok('Lieblingsbilder eröffnen das Buch', titel[0] === 'Unsere Lieblingsbilder');
  ok('Die Kategorien stehen dazwischen',
    titel.includes('Trauung') && titel.includes('Essen'), titel.join(' | '));
  ok('„Von früher" steht am Ende', titel[titel.length - 1] === 'Von früher',
    titel.join(' | '));

  // Ein Favorit darf nicht doppelt vorkommen.
  const alleIds = plan.kapitel.reduce(
    (a, k) => a.concat(kapitelFotos(k).map((f) => f.id)), []);
  ok('Kein Foto erscheint zweimal',
    new Set(alleIds).size === alleIds.length,
    alleIds.length + ' vs ' + new Set(alleIds).size);
  ok('Das Altfoto steckt im richtigen Kapitel',
    kapitelFotos(plan.kapitel.find((k) => k.titel === 'Von früher'))
      .some((f) => f.id === alt));

  // --- Vorschau ohne zu speichern
  const ohneFav = await (await modFetch(base, key, '/api/mod/buch/vorschau',
    { favoritenKapitel: false })).json();
  ok('Vorschau ohne Lieblingsbilder greift',
    !ohneFav.kapitel.some((k) => k.titel === 'Unsere Lieblingsbilder'));
  const wieVorher = await modGet(base, key, '/api/mod/buch');
  ok('Die Vorschau hat nichts gespeichert',
    wieVorher.kapitel.some((k) => k.titel === 'Unsere Lieblingsbilder'));

  // --- Kürzen dünnt gleichmässig aus statt vorne abzuschneiden
  const kurz = await (await modFetch(base, key, '/api/mod/buch/vorschau',
    { layout: 'raster', proSeite: 6, proKapitel: 3, favoritenKapitel: false })).json();
  const kapT = kapitelFotos(kurz.kapitel.find((k) => k.titel === 'Trauung'));
  ok('Kapitel werden gekürzt', kapT.length === 3, 'n=' + kapT.length);
  ok('Dabei bleibt der erste erhalten', kapT[0].id === trauung[0]);
  ok('Und der Verlauf reicht bis hinten',
    kapT[2].id !== trauung[1],
    'gewählt: ' + kapT.map((f) => trauung.indexOf(f.id)).join(','));

  // --- Seitenzahl folgt der Aufteilung
  const zwei = await (await modFetch(base, key, '/api/mod/buch/vorschau',
    { layout: 'raster', proSeite: 2 })).json();
  const sechs = await (await modFetch(base, key, '/api/mod/buch/vorschau',
    { layout: 'raster', proSeite: 6 })).json();
  ok('Weniger Bilder je Seite ergeben mehr Seiten', zwei.seiten > sechs.seiten,
    zwei.seiten + ' vs ' + sechs.seiten);

  // --- Einstellungen speichern
  const gespeichert = await (await modFetch(base, key, '/api/mod/buch', {
    titel: 'Anna & Tim', untertitel: '15. August', proSeite: 2, proKapitel: 5,
  })).json();
  ok('Einstellungen lassen sich merken',
    gespeichert.einstellungen.titel === 'Anna & Tim' &&
    gespeichert.einstellungen.proSeite === 2);
  const nachher = await modGet(base, key, '/api/mod/buch');
  ok('Sie überleben den nächsten Abruf', nachher.einstellungen.titel === 'Anna & Tim');
  ok('Unsinnige Werte werden begradigt',
    (await (await modFetch(base, key, '/api/mod/buch', { proSeite: 99 })).json())
      .einstellungen.proSeite === 4);

  // --- ZIP für Druckdienste
  const zip = await fetch(base + '/api/mod/buch/zip?key=' + encodeURIComponent(key));
  ok('ZIP wird ausgeliefert', zip.status === 200);
  ok('Mit sprechendem Dateinamen',
    /hochzeit-fotobuch\.zip/.test(zip.headers.get('content-disposition') || ''));
  const roh = Buffer.from(await zip.arrayBuffer());
  const drin = zipEintraege(roh);
  ok('Es enthält Bilder und ein Inhaltsverzeichnis', drin >= 2, 'n=' + drin);
  ok('Das Inhaltsverzeichnis ist dabei',
    roh.includes(Buffer.from('00_Inhalt.txt')));
  ok('Die Bilder tragen Kapitel- und Bildnummer',
    /\d\d_[\wäöüÄÖÜß-]+\/\d\d-\d\d\d_/.test(roh.toString('latin1')));

  ok('ZIP ohne Schlüssel wird abgewiesen',
    (await fetch(base + '/api/mod/buch/zip')).status === 401);
  ok('Bauplan braucht den Schlüssel',
    (await fetch(base + '/api/mod/buch')).status === 401);

  // --- Die Seite selbst
  const seite = await fetch(base + '/buch');
  const html = await seite.text();
  ok('Seite /buch lädt', seite.status === 200 && html.includes('buSeiten'));
  ok('Sie bringt die Werkzeugleiste mit', html.includes('buLeiste'));

  const css = await (await fetch(base + '/app.css')).text();
  ok('Das Stylesheet kennt den Druckfall',
    css.includes('@media print') && css.includes('size: A4 landscape'));
  ok('Und Seitenumbrüche je Buchseite',
    css.includes('page-break-after: always'));

  await collagen({ base, key, ok });
}

/* Collagen: wechselnde Seitenvorlagen statt gleichförmigem Raster. */
export async function collagen({ base, key, ok }) {

  // Genug Bilder für mehrere Seiten, mit gemischten Seitenverhältnissen.
  const t0 = Date.now() - 5 * 3600 * 1000;
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const quer = i % 3 !== 0;
    const r = await fetch(base + '/api/upload', {
      method: 'POST',
      body: (() => {
        const f = new FormData();
        f.append('clientId', 'coll-' + i + '-' + Date.now());
        f.append('uploader', 'Collage');
        f.append('kind', 'photo');
        f.append('takenAt', String(t0 + i * 60000));
        f.append('w', quer ? '1600' : '900');
        f.append('h', quer ? '900' : '1600');
        f.append('display', new Blob([JPEG], { type: 'image/jpeg' }), 'd.jpg');
        f.append('thumb', new Blob([JPEG], { type: 'image/jpeg' }), 't.jpg');
        return f;
      })(),
    });
    ids.push((await r.json()).id);
  }
  await wait(300);
  await modFetch(base, key, '/api/mod/category', { ids, category: 'tanz' });
  await wait(200);

  // --- Collage
  const coll = await (await modFetch(base, key, '/api/mod/buch/vorschau',
    { layout: 'collage', abwechslung: 'lebhaft', proKapitel: 0,
      favoritenKapitel: false, altfotos: false })).json();
  const kap = coll.kapitel.find((k) => k.titel === 'Tanz');
  ok('Das Kapitel bekommt fertige Seiten',
    !!kap && Array.isArray(kap.seiten) && kap.seiten.length > 0,
    'Seiten: ' + (kap ? kap.seiten.length : 0));

  const vorlagen = kap.seiten.map((s) => s.vorlage.id);
  ok('Die Aufteilungen wechseln', new Set(vorlagen).size > 1, vorlagen.join(', '));
  ok('Jede Seite bringt ihr Grid mit',
    kap.seiten.every((s) => Array.isArray(s.vorlage.bereiche) &&
      s.vorlage.spalten > 0 && s.vorlage.zeilen > 0));
  ok('Die Bilderzahl passt zur Vorlage',
    kap.seiten.every((s) => s.fotos.length > 0 &&
      s.fotos.length <= s.vorlage.bereiche.join(' ').split(/\s+/)
        .filter((x, i, a) => a.indexOf(x) === i).length));

  const inSeiten = kap.seiten.reduce((a, s) => a.concat(s.fotos.map((f) => f.id)), []);
  ok('Alle Bilder des Kapitels sind untergebracht',
    inSeiten.length === kap.anzahl, inSeiten.length + ' von ' + kap.anzahl);
  ok('Keines doppelt', new Set(inSeiten).size === inSeiten.length);

  // Der Heldenplatz einer 'gross2'-Seite soll ein breites Bild bekommen.
  const gross = kap.seiten.filter((s) => s.vorlage.id === 'gross2');
  if (gross.length) {
    const passend = gross.filter((s) => s.fotos[0].w >= s.fotos[0].h).length;
    ok('Breite Bilder landen auf den grossen Plätzen',
      passend >= Math.ceil(gross.length / 2),
      passend + ' von ' + gross.length);
  } else {
    ok('Breite Bilder landen auf den grossen Plätzen', true, '(keine solche Seite)');
  }

  // --- Raster zum Vergleich
  const raster = await (await modFetch(base, key, '/api/mod/buch/vorschau',
    { layout: 'raster', proSeite: 4, proKapitel: 0,
      favoritenKapitel: false, altfotos: false })).json();
  const rk = raster.kapitel.find((k) => k.titel === 'Tanz');
  ok('Im Raster ist jede Seite gleich',
    new Set(rk.seiten.map((s) => s.vorlage.id)).size === 1,
    rk.seiten.map((s) => s.vorlage.id).join(', '));
  ok('Und trägt die eingestellte Bilderzahl',
    rk.seiten.slice(0, -1).every((s) => s.fotos.length === 4),
    rk.seiten.map((s) => s.fotos.length).join(','));

  // --- Ruhiger Reigen nutzt weniger Vorlagen als der lebhafte
  const ruhig = await (await modFetch(base, key, '/api/mod/buch/vorschau',
    { layout: 'collage', abwechslung: 'ruhig', proKapitel: 0,
      favoritenKapitel: false, altfotos: false })).json();
  const ruk = ruhig.kapitel.find((k) => k.titel === 'Tanz');
  ok('„ruhig" bleibt gleichförmiger als „lebhaft"',
    new Set(ruk.seiten.map((s) => s.vorlage.id)).size <=
    new Set(vorlagen).size,
    'ruhig ' + new Set(ruk.seiten.map((s) => s.vorlage.id)).size +
    ' vs lebhaft ' + new Set(vorlagen).size);

  // --- Einstellungen halten
  const gespeichert = await (await modFetch(base, key, '/api/mod/buch',
    { layout: 'collage', abwechslung: 'lebhaft', fuellen: false })).json();
  ok('Gestaltung wird gespeichert',
    gespeichert.einstellungen.layout === 'collage' &&
    gespeichert.einstellungen.abwechslung === 'lebhaft' &&
    gespeichert.einstellungen.fuellen === false);
  ok('Unbekannte Abwechslung wird begradigt',
    (await (await modFetch(base, key, '/api/mod/buch',
      { abwechslung: 'wild' })).json()).einstellungen.abwechslung === 'gemischt');

  const css = await (await fetch(base + '/app.css')).text();
  ok('Das Stylesheet kennt das Füllen', css.includes('img.fuellt'));
}

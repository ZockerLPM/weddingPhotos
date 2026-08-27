// Grundfunktionen: Upload, Auslieferung, Moderation, Galerie, Fehlerfälle.
import { JPEG, wait, listenSSE, uploadPhoto, modFetch } from './helpers.mjs';

export const name = 'Grundfunktionen';

export default async function run({ base, key, ok }) {
  const sse = await listenSSE(base);

  // --- Upload
  const up = await uploadPhoto(base, { who: 'Anna', caption: 'Testfoto', clientId: 'cid-1' });
  ok('Upload liefert 200 und eine ULID',
    up.status === 200 && /^[0-9A-Z]{26}$/.test(up.body.id), JSON.stringify(up.body));
  const ID = up.body.id;

  // --- Idempotenz: derselbe clientId darf kein zweites Foto anlegen
  const dup = await uploadPhoto(base, { who: 'Anna', clientId: 'cid-1' });
  ok('Gleiche clientId liefert dieselbe ID zurück',
    dup.body.existed === true && dup.body.id === ID, JSON.stringify(dup.body));

  await wait(300);
  const photoEv = sse.events.find((e) => e.type === 'photo' && e.data.id === ID);
  ok('SSE meldet das neue Foto', !!photoEv && photoEv.data.uploader === 'Anna');

  // --- Dateien
  const d = await fetch(`${base}/i/${ID}-d.jpg`);
  const t = await fetch(`${base}/i/${ID}-t.jpg`);
  ok('Anzeigebild und Thumbnail sind abrufbar', d.status === 200 && t.status === 200);

  // --- Original nachreichen
  const fo = new FormData();
  fo.append('original', new Blob([JPEG], { type: 'image/jpeg' }), 'IMG_1234.JPG');
  const orig = await fetch(`${base}/api/original/${ID}`, { method: 'POST', body: fo });
  ok('Original wird angenommen', orig.status === 200);
  ok('Original liegt unter -o.jpg', (await fetch(`${base}/i/${ID}-o.jpg`)).status === 200);

  const feed = await (await fetch(base + '/api/feed')).json();
  ok('Feed meldet hasOriginal',
    feed.photos.find((p) => p.id === ID)?.hasOriginal === true);
  ok('Galerie ist anfangs geschlossen', feed.galleryOpen === false);

  // --- Moderation
  ok('Falscher Schlüssel wird abgewiesen',
    (await fetch(base + '/api/mod/list', { headers: { 'x-mod-key': 'falsch' } })).status === 401);

  await modFetch(base, key, '/api/mod/hide', { id: ID, hidden: true });
  await wait(200);
  ok('Verstecktes Foto verschwindet aus dem Feed',
    (await (await fetch(base + '/api/feed')).json()).photos.every((p) => p.id !== ID));
  ok('SSE meldet das Verstecken',
    sse.events.some((e) => e.type === 'hide' && e.data.hidden === true));

  await modFetch(base, key, '/api/mod/hide', { id: ID, hidden: false });
  await wait(200);
  ok('Wieder eingeblendetes Foto ist zurück',
    (await (await fetch(base + '/api/feed')).json()).photos.some((p) => p.id === ID));

  const ctl = await (await modFetch(base, key, '/api/mod/control', { action: 'pause' })).json();
  ok('Pause wird gesetzt', ctl.state.paused === true);
  await modFetch(base, key, '/api/mod/control', { action: 'resume' });

  // --- Galerie und ZIP
  ok('ZIP ist bei geschlossener Galerie gesperrt',
    (await fetch(base + '/api/gallery/zip')).status === 403);
  const zipKey = await fetch(`${base}/api/gallery/zip?key=${key}`);
  ok('ZIP ist mit MOD_KEY trotzdem erreichbar', zipKey.status === 200);
  const buf = Buffer.from(await zipKey.arrayBuffer());
  ok('ZIP hat einen gültigen Header', buf[0] === 0x50 && buf[1] === 0x4b, 'len=' + buf.length);

  await modFetch(base, key, '/api/mod/gallery', { open: true });
  ok('ZIP ist nach dem Öffnen frei zugänglich',
    (await fetch(base + '/api/gallery/zip')).status === 200);
  await modFetch(base, key, '/api/mod/gallery', { open: false });

  // --- Nachhol-Logik des SSE-Kanals
  const es2 = await fetch(base + '/api/stream?after=0');
  const r2 = es2.body.getReader();
  const first = new TextDecoder().decode((await r2.read()).value);
  ok('SSE liefert verpasste Events nach', first.includes('event: photo'), first.slice(0, 60));
  await r2.cancel();

  // --- Fehlerfälle
  const incomplete = new FormData();
  incomplete.append('clientId', 'x');
  ok('Unvollständiger Upload wird abgelehnt',
    (await fetch(base + '/api/upload', { method: 'POST', body: incomplete })).status === 400);

  const fo2 = new FormData();
  fo2.append('original', new Blob([JPEG]), 'x.jpg');
  ok('Original für unbekannte ID wird abgelehnt',
    (await fetch(base + '/api/original/01AAAAAAAAAAAAAAAAAAAAAAAA',
      { method: 'POST', body: fo2 })).status === 404);

  // Frisches Foto ohne Original – sonst greift vorher die has_original-Prüfung.
  const fresh = await uploadPhoto(base, { who: 'Leertest' });
  const empty = new FormData();
  empty.append('original', new Blob([]), 'leer.jpg');
  ok('Leeres Original wird abgelehnt',
    (await fetch(`${base}/api/original/${fresh.body.id}`,
      { method: 'POST', body: empty })).status === 400);

  // --- Seiten
  for (const [path, needle] of [
    ['/', 'Hochzeitsfotos'], ['/show', 'Fotowand'],
    ['/galerie', 'Galerie'], ['/mod', 'Moderation'], ['/box', 'Erzählecke'],
  ]) {
    const r = await fetch(base + path);
    const html = await r.text();
    ok(`Seite ${path} lädt`, r.status === 200 && html.includes(needle), 'Status ' + r.status);
  }

  const health = await (await fetch(base + '/api/health')).json();
  ok('Health meldet ok mit Plattenplatz', health.ok === true && health.disk !== null);

  sse.close();
}

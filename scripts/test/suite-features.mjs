// Foto-Aufgaben, namentliche Begrüssung, Rückblick, Auszeichnungen, Botschaften.
import { wait, listenSSE, uploadPhoto, modFetch } from './helpers.mjs';

export const name = 'Abendfunktionen';

export default async function run({ base, key, ok }) {
  const sse = await listenSSE(base);
  const t0 = Date.now() - 3 * 3600 * 1000;

  // --- Foto-Aufgaben
  const a1 = await uploadPhoto(base,
    { who: 'Anna', challengeId: 'lachen', caption: 'So schön!', takenAt: t0 });
  await wait(150);
  const feed = await (await fetch(base + '/api/feed')).json();
  ok('challengeId wird gespeichert und ausgeliefert',
    feed.photos.find((p) => p.id === a1.body.id)?.challengeId === 'lachen');

  // --- Namentliche Begrüssung
  ok('Erster Beitrag ist als firstUpload markiert',
    sse.events.find((e) => e.type === 'photo' && e.data.id === a1.body.id)
      ?.data.firstUpload === true);

  const a2 = await uploadPhoto(base, { who: 'Anna', challengeId: 'teller', takenAt: t0 + 60000 });
  await wait(150);
  ok('Zweiter Beitrag ist nicht mehr firstUpload',
    sse.events.find((e) => e.type === 'photo' && e.data.id === a2.body.id)
      ?.data.firstUpload === false);

  // --- Ein Abend mit mehreren Gästen
  await uploadPhoto(base, { who: 'Werner', caption: 'Prost!', takenAt: t0 + 20 * 60000 });
  await uploadPhoto(base, { who: 'Werner', takenAt: t0 + 50 * 60000 });
  await uploadPhoto(base, { who: 'Lisa', challengeId: 'haende', takenAt: t0 + 95 * 60000 });
  await uploadPhoto(base, { who: 'Lisa', challengeId: 'selfie', caption: 'Endlich mal wieder', takenAt: t0 + 100 * 60000 });
  await uploadPhoto(base, { who: 'Lisa', challengeId: 'fenster', takenAt: t0 + 140 * 60000 });
  const msg = await uploadPhoto(base, { who: 'Opa Franz', kind: 'message', takenAt: t0 + 160 * 60000 });
  await wait(200);

  // --- Rückblick
  const recap = await (await fetch(base + '/api/recap')).json();
  ok('Rückblick liefert Fotos', recap.photos?.length > 0, 'n=' + (recap.photos || []).length);
  ok('Rückblick ist chronologisch',
    recap.photos.every((p, i) => i === 0 || recap.photos[i - 1].id <= p.id));
  ok('Rückblick enthält keine Botschaften',
    !recap.photos.some((p) => p.kind === 'message'));
  const drin = new Set(recap.photos.map((p) => p.uploader));
  ok('Jeder Foto-Gast kommt im Rückblick vor',
    ['Anna', 'Werner', 'Lisa'].every((w) => drin.has(w)), [...drin].join(', '));

  // --- Auszeichnungen
  const awards = recap.awards || [];
  const byTitle = Object.fromEntries(awards.map((a) => [a.title, a]));
  ok('Auszeichnungen werden geliefert', awards.length >= 4, 'n=' + awards.length);
  ok('Fleissigster Fotograf ist Lisa',
    byTitle['Fleissigster Fotograf']?.who === 'Lisa',
    JSON.stringify(byTitle['Fleissigster Fotograf']));
  ok('Aufgabenjäger wird vergeben', !!byTitle['Der Aufgabenjäger']);
  ok('Stimme des Abends ist Opa Franz',
    byTitle['Die Stimme des Abends']?.who === 'Opa Franz');
  ok('Titel verteilen sich auf mehrere Gäste',
    new Set(awards.map((a) => a.who)).size >= 3,
    awards.map((a) => a.who).join(', '));
  ok('Jede Auszeichnung ist vollständig',
    awards.every((a) => a.icon && a.title && a.who && a.detail));

  // --- Fernsteuerung
  ok('Aktion "recap" wird angenommen',
    (await modFetch(base, key, '/api/mod/control', { action: 'recap' })).status === 200);
  await wait(200);
  ok('SSE meldet den Rückblick',
    sse.events.some((e) => e.type === 'control' && e.data.recap === 1));
  ok('Unbekannte Aktion wird abgelehnt',
    (await modFetch(base, key, '/api/mod/control', { action: 'quatsch' })).status === 400);

  // --- Botschaften
  const feed2 = await (await fetch(base + '/api/feed')).json();
  ok('Botschaft erscheint für die Galerie im Feed',
    feed2.photos.some((p) => p.id === msg.body.id && p.kind === 'message'));

  sse.close();
  await videos({ base, ok });
}

// Video-Upload: eigener Pfad, weil hier schon einmal etwas schiefging.
export async function videos({ base, ok }) {
  const up = await uploadPhoto(base, { who: 'Filmer', kind: 'video' });
  ok('Video-Upload wird angenommen', up.status === 200 && !!up.body.id);
  const id = up.body.id;

  // Original mit realistischer Grösse und iPhone-Endung nachreichen.
  const gross = Buffer.alloc(3 * 1024 * 1024, 0x7a);
  const fo = new FormData();
  fo.append('original', new Blob([gross], { type: 'video/quicktime' }), 'IMG_4711.MOV');
  const r = await fetch(`${base}/api/original/${id}`, { method: 'POST', body: fo });
  ok('Video-Original wird angenommen', r.status === 200, 'Status ' + r.status);

  const feed = await (await fetch(base + '/api/feed')).json();
  const p = feed.photos.find((x) => x.id === id);
  ok('Video steht im Feed', !!p && p.kind === 'video');
  ok('Endung wird aus dem Dateinamen übernommen', p?.ext === 'mov', 'ext=' + p?.ext);
  ok('Video ist als Original markiert', p?.hasOriginal === true);

  const datei = await fetch(`${base}/i/${id}-o.mov`);
  ok('Video ist abrufbar', datei.status === 200);
  ok('Video hat die volle Grösse',
    Number(datei.headers.get('content-length')) === gross.length,
    datei.headers.get('content-length'));

  // Vorschaubild muss unabhängig vom Video existieren – auch wenn der
  // Browser kein Standbild gewinnen konnte, wird ein Platzhalter geschickt.
  ok('Vorschaubild liegt vor', (await fetch(`${base}/i/${id}-d.jpg`)).status === 200);
  ok('Video landet nicht in der Ambient-Rotation der Fotowand',
    p?.kind !== 'photo');
}

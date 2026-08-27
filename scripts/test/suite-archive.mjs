// Mitgebrachte Altfotos (Kinderbilder o.ä.) und der Aufgaben-Editor.
import { wait, listenSSE, uploadPhoto, modFetch } from './helpers.mjs';

export const name = 'Altfotos & Aufgaben-Editor';

const TAG = 24 * 3600 * 1000;

export default async function run({ base, key, ok }) {
  const sse = await listenSSE(base);
  const jetzt = Date.now();

  // --- Abendfotos (plausible Zeitstempel)
  await uploadPhoto(base, { who: 'Anna', takenAt: jetzt - 90 * 60000 });
  await uploadPhoto(base, { who: 'Anna', takenAt: jetzt - 30 * 60000 });
  await uploadPhoto(base, { who: 'Werner', takenAt: jetzt - 10 * 60000 });

  // --- Mitgebrachte Kinderbilder von 1995 und 2003
  const alt1 = await uploadPhoto(base,
    { who: 'Oma', takenAt: new Date('1995-07-14T15:00:00Z').getTime() });
  const alt2 = await uploadPhoto(base,
    { who: 'Oma', takenAt: new Date('2003-05-02T11:00:00Z').getTime() });
  // --- Handyuhr geht drei Tage nach
  const schief = await uploadPhoto(base, { who: 'Werner', takenAt: jetzt + 3 * TAG });
  await wait(250);

  const feed = await (await fetch(base + '/api/feed')).json();
  const byId = Object.fromEntries(feed.photos.map((p) => [p.id, p]));

  ok('Altfoto wird als archive erkannt', byId[alt1.body.id]?.archive === true);
  ok('Zweites Altfoto ebenfalls', byId[alt2.body.id]?.archive === true);
  ok('Zeitstempel aus der Zukunft gilt als unplausibel',
    byId[schief.body.id]?.archive === true);
  ok('Abendfoto bleibt normal',
    feed.photos.filter((p) => p.uploader === 'Anna').every((p) => p.archive === false));

  ok('Altfoto bekommt den Upload als effektive Zeit',
    Math.abs(byId[alt1.body.id].effectiveAt - jetzt) < 5 * 60000,
    'Differenz ' + (byId[alt1.body.id].effectiveAt - jetzt) + ' ms');
  ok('Echtes Aufnahmedatum bleibt erhalten',
    new Date(byId[alt1.body.id].takenAt).getFullYear() === 1995);

  // --- Auszeichnungen dürfen davon nicht verfälscht werden
  const recap = await (await fetch(base + '/api/recap')).json();
  const byTitle = Object.fromEntries((recap.awards || []).map((a) => [a.title, a]));

  const frueh = byTitle['Der frühe Vogel'];
  ok('Früher Vogel ist kein Kinderbild von 1995',
    frueh && !frueh.detail.includes('1995') && frueh.who !== 'Oma',
    JSON.stringify(frueh));
  ok('Fleissigster Fotograf zählt nur Fotos vom Fest',
    byTitle['Fleissigster Fotograf']?.who === 'Anna',
    JSON.stringify(byTitle['Fleissigster Fotograf']));
  ok('Archivar-Titel geht an Oma',
    byTitle['Der Archivar']?.who === 'Oma', JSON.stringify(byTitle['Der Archivar']));

  // --- Rückblick trennt sauber
  ok('Altfotos stehen im eigenen Vorspann',
    recap.archive?.length === 3, 'n=' + (recap.archive || []).length);
  ok('Hauptteil enthält keine Altfotos',
    recap.photos.every((p) => p.archive === false));
  ok('Hauptteil ist nach effektiver Zeit sortiert',
    recap.photos.every((p, i) => i === 0
      || recap.photos[i - 1].effectiveAt <= p.effectiveAt));

  // --- Aufgaben: Standardliste
  const def = await (await fetch(base + '/api/challenges')).json();
  ok('Standard-Aufgaben werden geliefert', def.challenges.length === 8);
  ok('Feed liefert die Aufgaben mit', feed.challenges?.length === 8);

  // --- Aufgaben ändern
  const neu = [
    { id: 'lachen', icon: '😄', text: 'Jemand, der gerade lacht' },
    { id: '', icon: '🍺', text: 'Das erste Bier des Abends' },
  ];
  const saved = await (await modFetch(base, key, '/api/mod/challenges', { challenges: neu })).json();
  ok('Geänderte Liste wird gespeichert', saved.challenges.length === 2);
  ok('Bestehende id bleibt erhalten', saved.challenges[0].id === 'lachen');
  ok('Neue Aufgabe bekommt eine id', /^[a-z0-9_-]+$/.test(saved.challenges[1].id));
  await wait(200);
  ok('SSE meldet die neue Aufgabenliste',
    sse.events.some((e) => e.type === 'challenges' && e.data.challenges.length === 2));
  ok('Abruf liefert die geänderte Liste',
    (await (await fetch(base + '/api/challenges')).json()).challenges.length === 2);

  // --- Putzen der Eingaben
  const dreck = await (await modFetch(base, key, '/api/mod/challenges', {
    challenges: [
      { id: 'a b/c!', icon: '🎯', text: '  viel   Leerraum  ' },
      { id: 'x', icon: '', text: '' },
      { id: 'x', icon: '🙂', text: 'Doppelte id' },
      { id: 'x', icon: '🙃', text: 'Nochmal doppelte id' },
    ],
  })).json();
  ok('Leere Aufgaben fliegen raus', dreck.challenges.length === 3);
  ok('Text wird normalisiert', dreck.challenges[0].text === 'viel Leerraum');
  ok('id wird bereinigt', dreck.challenges[0].id === 'abc');
  ok('Doppelte ids werden aufgelöst',
    new Set(dreck.challenges.map((c) => c.id)).size === 3,
    dreck.challenges.map((c) => c.id).join(', '));
  ok('Fehlendes Symbol bekommt einen Ersatz', dreck.challenges[1].icon === '🙂');

  ok('Ungültige Eingabe wird abgelehnt',
    (await modFetch(base, key, '/api/mod/challenges', { challenges: 'quatsch' })).status === 400);
  ok('Aufgaben-Editor braucht den Schlüssel',
    (await fetch(base + '/api/mod/challenges', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenges: [] }),
    })).status === 401);

  // --- Zurücksetzen
  const reset = await (await modFetch(base, key, '/api/mod/challenges/reset', {})).json();
  ok('Zurücksetzen stellt die Standardliste her', reset.challenges.length === 8);

  sse.close();
}

// Gemeinsame Helfer für die Testsuiten.

// Gültiges 1x1-JPEG – so werden echte Dateien geschrieben statt Attrappen.
export const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////' +
  '////////////////////////////////////////////////////wgALCAABAAEBAREA/8QA' +
  'FBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeChecker(results) {
  return function ok(name, condition, extra = '') {
    results.push({ name, passed: !!condition, extra });
    console.log((condition ? '  \x1b[32mOK\x1b[0m   ' : '  \x1b[31mFAIL\x1b[0m ') +
      name + (condition ? '' : '  ' + extra));
  };
}

// Lauscht auf dem SSE-Kanal und sammelt alle Events ein.
export async function listenSSE(base) {
  const events = [];
  const res = await fetch(base + '/api/stream');
  const reader = res.body.getReader();
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = /^event: (.+)$/m.exec(chunk)?.[1];
          const data = /^data: (.+)$/m.exec(chunk)?.[1];
          if (type) events.push({ type, data: JSON.parse(data) });
        }
      }
    } catch { /* beim Abbrechen erwartet */ }
  })();
  await wait(200);
  return { events, close: () => reader.cancel().catch(() => {}) };
}

let counter = 0;

// Lädt ein Foto so hoch, wie es der Browser tut (Anzeigebild + Thumbnail).
export async function uploadPhoto(base, opts = {}) {
  const {
    who = 'Testgast', kind = 'photo', caption = '',
    challengeId = null, takenAt = Date.now(), clientId,
  } = opts;

  const f = new FormData();
  f.append('clientId', clientId || `test-${++counter}-${Date.now()}`);
  f.append('uploader', who);
  f.append('deviceId', 'dev-' + who);
  f.append('kind', kind);
  f.append('takenAt', String(takenAt));
  f.append('caption', caption);
  if (challengeId) f.append('challengeId', challengeId);
  f.append('w', '1600');
  f.append('h', '1200');
  f.append('display', new Blob([JPEG], { type: 'image/jpeg' }), 'display.jpg');
  f.append('thumb', new Blob([JPEG], { type: 'image/jpeg' }), 'thumb.jpg');

  const r = await fetch(base + '/api/upload', { method: 'POST', body: f });
  return { status: r.status, body: await r.json() };
}

export function modFetch(base, key, path, body) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-mod-key': key },
    body: JSON.stringify(body || {}),
  });
}

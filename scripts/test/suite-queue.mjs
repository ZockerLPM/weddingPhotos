/* Testet public/js/queue.js in einer nachgebauten Browser-Umgebung.
 *
 * Kernpunkt: iOS Safari kann eine File-Referenz aus <input type="file">
 * nicht zuverlässig aus IndexedDB zurückgeben – sie kommt als 0-Byte-Blob
 * zurück. Das simuliert die Klon-Funktion "wieIOS". Ohne Materialisierung
 * der Bytes landet dann ein leeres Original auf dem Server.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { wait } from './helpers.mjs';

export const name = 'Upload-Warteschlange';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_JS = path.join(__dirname, '..', '..', 'public', 'js', 'queue.js');

// Minimales IndexedDB mit strukturiertem Klonen.
function makeFakeIDB(clone) {
  const store = new Map();
  return {
    open() {
      const rq = {};
      setTimeout(() => {
        rq.result = {
          transaction() {
            const t = {};
            const os = {
              put(v) { store.set(v.clientId, clone(v)); },
              delete(k) { store.delete(k); },
              getAll() { return { result: [...store.values()].map(clone) }; },
            };
            setTimeout(() => t.oncomplete && t.oncomplete(), 0);
            t.objectStore = () => os;
            return t;
          },
        };
        rq.onsuccess && rq.onsuccess();
      }, 0);
      return rq;
    },
  };
}

// Datei-Referenzen (__fileRef) verlieren beim Klonen ihren Inhalt.
function wieIOS(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = (v && v.__fileRef)
      ? Object.assign(new Blob([]), { name: v.name, __fileRef: true })
      : v;
  }
  return out;
}
const wieChrome = (o) => ({ ...o });

async function runOne(base, ok, label, clone) {
  const sandbox = {
    indexedDB: makeFakeIDB(clone),
    // Relative URLs wie im Browser gegen den Testserver auflösen.
    fetch: (u, o) => fetch(String(u).startsWith('http') ? u : base + u, o),
    FormData, Blob, setTimeout, clearTimeout,
    setInterval: () => 0,
    console, Date, Math, Promise, JSON, Error, window: {},
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(QUEUE_JS, 'utf8'), sandbox);
  const Q = sandbox.window.UploadQueue;

  const bytes = Buffer.alloc(20000, 0x42);
  const fileRef = new Blob([bytes], { type: 'image/jpeg' });
  fileRef.__fileRef = true;
  fileRef.name = 'IMG_9999.JPG';

  const finished = new Promise((resolve) => {
    Q.onChange((item, phase) => { if (phase === 'done') resolve(item); });
  });

  await Q.enqueue({
    clientId: `q-${label}-${Date.now()}`,
    uploader: 'Warteschlange' + label,
    deviceId: 'dev', kind: 'photo', caption: '', challengeId: null,
    takenAt: Date.now(), filename: 'IMG_9999.JPG', w: 1600, h: 1200,
    displayBlob: new Blob([bytes], { type: 'image/jpeg' }),
    thumbBlob: new Blob([bytes.subarray(0, 500)], { type: 'image/jpeg' }),
    originalBlob: fileRef,
  });

  const item = await Promise.race([finished, wait(10000).then(() => null)]);
  ok(`${label}: Vorgang wird abgeschlossen`, !!item);
  if (!item) return;

  const feed = await (await fetch(base + '/api/feed')).json();
  const photo = feed.photos.find((p) => p.id === item.serverId);
  ok(`${label}: Foto liegt auf dem Server`, !!photo);
  ok(`${label}: Original wurde übertragen`, photo?.hasOriginal === true,
    'originalLost=' + !!item.originalLost);

  if (photo?.hasOriginal) {
    const r = await fetch(`${base}/i/${photo.id}-o.${photo.ext}`);
    const len = Number(r.headers.get('content-length'));
    ok(`${label}: Original hat die volle Grösse`, len === 20000, 'sind ' + len + ' Bytes');
  }
}

export default async function run({ base, ok }) {
  await runOne(base, ok, 'iOS', wieIOS);
  await runOne(base, ok, 'Chrome', wieChrome);
}

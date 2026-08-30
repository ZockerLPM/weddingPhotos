/* Testet public/js/gallery.js in einer nachgebauten Browser-Umgebung.
 *
 * Zwei Dinge, die sich nur am laufenden Code zeigen:
 *
 *   1. Der Weg in die Galerie des Handys ist auf Android ein anderer als
 *      auf iOS. Dort gibt es kein "In Fotos sichern" im Teilen-Blatt --
 *      ein gewoehnlicher Download landet ueber den Medien-Scanner in der
 *      Galerie. Also darf auf Android kein Erklaerblatt aufgehen.
 *   2. Ein <video> ohne poster zeigt vor dem Abspielen ein schwarzes
 *      Rechteck. Das Standbild liegt bereit und gehoert gesetzt.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { wait, uploadPhoto, modFetch } from './helpers.mjs';

export const name = 'Galerie (Browser)';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GALLERY_JS = path.join(__dirname, '..', '..', 'public', 'js', 'gallery.js');
const GALERIE_HTML = path.join(__dirname, '..', '..', 'public', 'galerie.html');

/* Ein DOM, das gerade so viel kann, wie gallery.js verlangt.
 *
 * Die ids kommen aus der echten galerie.html - so faellt auf, wenn das
 * Skript ein Element anspricht, das die Seite gar nicht mitbringt.
 */
function makeDOM(ids) {
  const alle = new Map();

  function neu(tag) {
    const kinder = [];
    const klassen = new Set();
    const horcher = {};
    const k = {
      tagName: String(tag).toUpperCase(),
      children: kinder,
      style: {},
      dataset: {},
      attrs: {},
      parent: null,
      textContent: '',
      className: '',
      classList: {
        add: (c) => klassen.add(c),
        remove: (c) => klassen.delete(c),
        contains: (c) => klassen.has(c),
        toggle: (c, an) => {
          const soll = an === undefined ? !klassen.has(c) : !!an;
          if (soll) klassen.add(c); else klassen.delete(c);
          return soll;
        },
      },
      appendChild: (kind) => { kinder.push(kind); kind.parent = k; return kind; },
      remove: () => {
        if (!k.parent) return;
        const i = k.parent.children.indexOf(k);
        if (i >= 0) k.parent.children.splice(i, 1);
        k.parent = null;
      },
      setAttribute: (n, v) => { k.attrs[n] = String(v); },
      getAttribute: (n) => (n in k.attrs ? k.attrs[n] : null),
      addEventListener: (typ, fn) => { (horcher[typ] = horcher[typ] || []).push(fn); },
      click: () => k.feuere('click'),
      feuere: (typ, ev) => {
        const liste = horcher[typ] || [];
        const e = ev || { target: k, stopPropagation() {}, preventDefault() {} };
        liste.forEach((fn) => fn(e));
      },
      // Nur so tief, wie gallery.js sucht: img/video im Vollbild.
      querySelector: (sel) => {
        const wollen = sel.split(',').map((x) => x.trim().toUpperCase());
        const suche = (n) => {
          for (const kind of n.children) {
            if (wollen.includes(kind.tagName)) return kind;
            const tief = suche(kind);
            if (tief) return tief;
          }
          return null;
        };
        return suche(k);
      },
      querySelectorAll: () => [],
    };
    return k;
  }

  const body = neu('body');
  ids.forEach(({ id, klassen, text }) => {
    const e = neu('div');
    e.id = id;
    e.className = klassen;
    e.textContent = text;
    // Der Startzustand der Seite zaehlt: "hidden" muss wirklich gesetzt
    // sein, sonst prueft der Test nichts.
    klassen.split(/\s+/).filter(Boolean).forEach((c) => e.classList.add(c));
    alle.set(id, e);
    body.appendChild(e);
  });

  return {
    body,
    alle,
    neu,
    // Fehlende ids sollen auffallen, nicht still zu undefined werden.
    getElementById: (id) => (alle.has(id) ? alle.get(id) : null),
    createElement: (t) => neu(t),
    addEventListener: () => {},
  };
}

// Alle Elemente mit id aus der echten Seite ziehen -- samt ihrer Klassen.
function idsAusHtml() {
  const html = fs.readFileSync(GALERIE_HTML, 'utf8');
  const raus = [];
  for (const tag of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const id = / id="([^"]+)"/.exec(tag[0]);
    if (!id) continue;
    const kl = / class="([^"]*)"/.exec(tag[0]);
    // Die Aufschrift gleich mitnehmen -- sonst prueft ein Test auf
    // Knopftexte nur noch leere Zeichenketten.
    const nach = html.slice(tag.index + tag[0].length);
    const bis = nach.indexOf('<');
    raus.push({
      id: id[1],
      klassen: kl ? kl[1] : '',
      text: (bis < 0 ? '' : nach.slice(0, bis)).trim(),
    });
  }
  return raus;
}

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/* Die Galerie in der Sandbox starten und ein Handle zurueckgeben. */
async function starten(base, ua, extra = {}) {
  const dom = makeDOM(idsAusHtml());
  const geladen = [];      // was per <a download> geholt wurde
  const geteilt = [];      // was an navigator.share ging

  const echtesNeu = dom.neu;
  dom.createElement = (t) => {
    const e = echtesNeu(t);
    if (String(t).toLowerCase() === 'a') {
      e.click = () => {
        if (e.download !== undefined && e.href) {
          geladen.push({ href: String(e.href), name: e.download });
        }
      };
    }
    return e;
  };

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Promise, Array, Object, String, Number, Boolean,
    RegExp, Error, Set, Map, isNaN, parseInt, parseFloat,
    URL, URLSearchParams, Blob, File, FormData,
    Image: function () {},
    document: dom,
    fetch: (u, o) => fetch(String(u).startsWith('http') ? u : base + u, o),
    EventSource: function () { this.addEventListener = () => {}; this.close = () => {}; },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { search: extra.search || '', href: base + '/galerie' },
    navigator: {
      userAgent: ua,
      platform: extra.platform || 'Linux armv8l',
      maxTouchPoints: 5,
    },
  };
  if (extra.share) {
    sandbox.navigator.share = (d) => { geteilt.push(d); return extra.share(d); };
    sandbox.navigator.canShare = extra.canShare || (() => true);
  }
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.Challenges = { byId: () => null, adopt: () => {} };
  sandbox.window.scrollTo = () => {};

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(GALLERY_JS, 'utf8'), sandbox, { filename: 'gallery.js' });
  await wait(500);   // der Feed-Abruf beim Start

  return { dom, sandbox, geladen, geteilt, el: (id) => dom.getElementById(id) };
}

/* Im Raster stehen auch Abschnitts-Ueberschriften -- nur die Kacheln
 * tragen eine Foto-id.
 */
function kacheln(a) {
  return a.el('grid').children.filter((k) => k.dataset && k.dataset.id);
}

// Die erste Kachel oeffnen, die im Vollbild das gesuchte Medium zeigt.
function oeffneBis(a, tag) {
  for (const kachel of kacheln(a)) {
    kachel.feuere('click');
    const m = a.el('lbMedia').querySelector('img, video');
    if (m && m.tagName === tag) return m;
  }
  return null;
}

export default async function run({ base, key, ok }) {
  await uploadPhoto(base, { who: 'Bianca', takenAt: Date.now() });
  await wait(300);
  await modFetch(base, key, '/api/mod/gallery', { open: true });
  await wait(200);

  // ---------------------------------------------------------- Android
  const a = await starten(base, ANDROID, {
    share: () => Promise.resolve(), canShare: () => true,
  });
  ok('Die Galerie startet in der Sandbox',
    kacheln(a).length > 0, 'Kacheln: ' + kacheln(a).length);
  ok('Das Vollbild ist zu Beginn zu',
    a.el('lightbox').classList.contains('hidden'));

  kacheln(a)[0].feuere('click');
  ok('Ein Tipp oeffnet das Vollbild', !a.el('lightbox').classList.contains('hidden'));
  ok('Der Sichern-Knopf ist auf Android sichtbar',
    !a.el('lbSichern').classList.contains('hidden'));
  ok('Und benennt das richtige Ziel',
    /Galerie/.test(a.el('lbSichern').textContent), a.el('lbSichern').textContent);

  a.el('lbSichern').feuere('click');
  await wait(600);
  ok('Android oeffnet KEIN Erklaerblatt',
    a.el('hilfeBlatt').classList.contains('hidden'));
  ok('Android teilt nicht, sondern laedt',
    a.geladen.length === 1 && a.geteilt.length === 0,
    'geladen ' + a.geladen.length + ', geteilt ' + a.geteilt.length);
  ok('Und sagt, wo die Datei landet',
    /Downloads/.test(a.el('toast').textContent), a.el('toast').textContent);
  ok('Auf Android steht kein Grossdatei-Hinweis',
    !/passenden Weg/.test(a.el('lbTipp').textContent), a.el('lbTipp').textContent);

  // ---------------------------------------------------------- iPhone
  const i = await starten(base, IPHONE, {
    platform: 'iPhone',
    share: () => Promise.resolve(), canShare: () => true,
  });
  kacheln(i)[0].feuere('click');
  ok('Auf iOS bleibt es bei „In Fotos sichern"',
    /Fotos/.test(i.el('lbSichern').textContent), i.el('lbSichern').textContent);
  ok('Auf iOS bleibt der Hinweis aufs lange Druecken',
    !i.el('lbTipp').classList.contains('hidden') &&
    /gedrueckt halten|gedrückt halten/.test(i.el('lbTipp').textContent),
    i.el('lbTipp').textContent);

  i.el('lbSichern').feuere('click');
  await wait(800);
  ok('Auf iOS geht der Weg weiterhin ueber das Teilen-Blatt',
    i.geteilt.length === 1 && i.geladen.length === 0,
    'geteilt ' + i.geteilt.length + ', geladen ' + i.geladen.length);

  await videoImVollbild({ base, ok });
}

/* Ein Video im Vollbild: der poster muss gesetzt sein, sonst bleibt das
 * Bild bis zum Antippen schwarz.
 */
async function videoImVollbild({ base, ok }) {
  const v = await uploadPhoto(base, { who: 'Nils', kind: 'video', takenAt: Date.now() });
  await wait(200);
  // Ein Original anhaengen, damit die Galerie den Player zeigt -- ohne
  // Original bleibt es beim Standbild und es gibt gar kein <video>.
  const fd = new FormData();
  fd.append('original', new Blob([Buffer.alloc(4096, 7)], { type: 'video/quicktime' }),
    'IMG_9001.MOV');
  const r = await fetch(base + '/api/original/' + v.body.id, { method: 'POST', body: fd });
  ok('Das Video-Original wird angenommen', r.status === 200, 'Status ' + r.status);
  await wait(400);

  const a = await starten(base, ANDROID, {
    share: () => Promise.resolve(), canShare: () => true,
  });
  const medium = oeffneBis(a, 'VIDEO');
  ok('Der Player steht im Vollbild', !!medium, medium ? '' : 'kein <video> gefunden');
  if (!medium) return;

  ok('Mit gesetztem Standbild statt schwarzem Rechteck',
    typeof medium.poster === 'string' && /-d\.jpg$/.test(medium.poster),
    String(medium.poster));
  ok('Das Standbild gehoert zu diesem Video',
    String(medium.poster).includes(v.body.id), String(medium.poster));
  ok('Und die Videoquelle steht daneben',
    /\/i\//.test(String(medium.src)) && String(medium.src) !== String(medium.poster),
    String(medium.src));
}

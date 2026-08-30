/* Fotobuch.
 *
 * Zwei Wege, ein Bauplan:
 *
 *   1. Eine Druckseite (/buch), die der Browser über „Drucken → Als PDF
 *      sichern" zu einer fertigen Datei macht. Kein zusätzliches Paket
 *      nötig, dafür volle Gestaltungsfreiheit und eine Vorschau, die
 *      genau das zeigt, was hinterher herauskommt.
 *
 *   2. Ein durchnummeriertes ZIP für Druckdienste. Die Anbieter füllen
 *      ihre Vorlagen in Dateinamen-Reihenfolge – deshalb sind Kapitel
 *      und Position im Namen kodiert.
 *
 * Beides kommt aus derselben Beschreibung (plan()), sonst zeigt die
 * Vorschau etwas anderes als der Export.
 */
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import * as db from './db.js';
import { DEFAULT_KATEGORIEN, sanitizeKategorien } from './kategorien.js';
import { seitenBauen } from './buchvorlagen.js';

export const STANDARD = {
  titel: 'Unsere Hochzeit',
  untertitel: '',
  widmung: '',
  layout: 'collage',      // 'collage' = wechselnde Vorlagen, 'raster' = gleichmässig
  abwechslung: 'gemischt',// ruhig | gemischt | lebhaft (nur bei collage)
  fuellen: true,          // Bilder füllen ihren Platz (beschneiden) …
                          // … statt vollständig hineinzupassen
  proSeite: 4,            // nur beim Raster: 1, 2, 4 oder 6
  proKapitel: 24,         // 0 = ohne Begrenzung
  beschriftung: true,     // Name und Uhrzeit unter dem Bild
  favoritenKapitel: true,
  altfotos: true,
  kapitel: null,          // null = alle belegten, sonst Liste von ids
};

function kategorien() {
  try {
    const roh = db.getSetting('kategorien');
    if (roh) {
      const liste = sanitizeKategorien(JSON.parse(roh));
      if (liste && liste.length) return liste;
    }
  } catch { /* kaputt -> Standard */ }
  return DEFAULT_KATEGORIEN;
}

export function einstellungen() {
  try {
    const roh = db.getSetting('buch');
    if (roh) return { ...STANDARD, ...JSON.parse(roh) };
  } catch { /* kaputt -> Standard */ }
  return { ...STANDARD };
}

export function speichern(eingabe) {
  const e = eingabe || {};
  const sauber = {
    titel: String(e.titel ?? STANDARD.titel).trim().slice(0, 80),
    untertitel: String(e.untertitel ?? '').trim().slice(0, 120),
    widmung: String(e.widmung ?? '').trim().slice(0, 600),
    layout: e.layout === 'raster' ? 'raster' : 'collage',
    abwechslung: ['ruhig', 'gemischt', 'lebhaft'].includes(e.abwechslung)
      ? e.abwechslung : 'gemischt',
    fuellen: e.fuellen !== false,
    proSeite: [1, 2, 4, 6].includes(Number(e.proSeite)) ? Number(e.proSeite) : 4,
    proKapitel: Math.max(0, Math.min(500, Number(e.proKapitel) || 0)),
    beschriftung: e.beschriftung !== false,
    favoritenKapitel: e.favoritenKapitel !== false,
    altfotos: e.altfotos !== false,
    kapitel: Array.isArray(e.kapitel)
      ? e.kapitel.map((k) => String(k).slice(0, 40)).slice(0, 40)
      : null,
  };
  db.setSetting('buch', JSON.stringify(sauber));
  return sauber;
}

/* Gleichmässig ausdünnen statt vorne abschneiden.
 *
 * Ein Kapitel auf 24 Bilder zu kürzen, indem man die ersten 24 nimmt,
 * erzählt nur den Anfang. Über die ganze Zeitspanne verteilt bleibt der
 * Verlauf erhalten.
 */
function ausduennen(liste, max) {
  if (!max || liste.length <= max) return liste;
  const schritt = liste.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(liste[Math.floor(i * schritt)]);
  return out;
}

const nachZeit = (a, b) =>
  (a.effective_at || a.uploaded_at) - (b.effective_at || b.uploaded_at);

export function plan(cfg) {
  const c = cfg || einstellungen();
  const sichtbar = db.listVisible().filter((p) => p.kind === 'photo' || p.has_original);
  const kapitel = [];
  const vergeben = new Set();

  if (c.favoritenKapitel) {
    const fav = sichtbar.filter((p) => p.favorite).sort(nachZeit);
    if (fav.length) {
      fav.forEach((p) => vergeben.add(p.id));
      kapitel.push({ id: '★', titel: 'Unsere Lieblingsbilder', icon: '★', fotos: fav });
    }
  }

  const erlaubt = Array.isArray(c.kapitel) ? new Set(c.kapitel) : null;
  for (const k of kategorien()) {
    if (erlaubt && !erlaubt.has(k.id)) continue;
    const drin = sichtbar
      .filter((p) => p.category === k.id && !p.archive && !vergeben.has(p.id))
      .sort(nachZeit);
    if (!drin.length) continue;
    drin.forEach((p) => vergeben.add(p.id));
    kapitel.push({ id: k.id, titel: k.name, icon: k.icon, fotos: ausduennen(drin, c.proKapitel) });
  }

  // Alles, was keiner Kategorie zugeordnet ist.
  const rest = sichtbar
    .filter((p) => !p.archive && !vergeben.has(p.id))
    .sort(nachZeit);
  if (rest.length) {
    rest.forEach((p) => vergeben.add(p.id));
    kapitel.push({
      id: '∅', titel: 'Weitere Aufnahmen', icon: '📷',
      fotos: ausduennen(rest, c.proKapitel),
    });
  }

  if (c.altfotos) {
    const alt = sichtbar.filter((p) => p.archive)
      .sort((a, b) => (a.taken_at || a.uploaded_at) - (b.taken_at || b.uploaded_at));
    if (alt.length) {
      kapitel.push({
        id: '📼', titel: 'Von früher', icon: '📼',
        fotos: ausduennen(alt, c.proKapitel),
      });
    }
  }

  // Seiten hier bauen, nicht erst im Browser – so zeigt die Vorschau
  // dieselbe Aufteilung, die auch der Export kennt.
  for (const k of kapitel) {
    k.seiten = seitenBauen(k.fotos, c.layout, c.proSeite, c.abwechslung);
  }

  const fotos = kapitel.reduce((n, k) => n + k.fotos.length, 0);
  const seiten = kapitel.reduce((n, k) => n + 1 + k.seiten.length, 1);

  return { einstellungen: c, kapitel, fotos, seiten };
}

// Für die Druckseite: nur, was zum Anzeigen gebraucht wird.
export function planFuerSeite(cfg) {
  const p = plan(cfg);
  return {
    einstellungen: p.einstellungen,
    fotos: p.fotos,
    seiten: p.seiten,
    kapitel: p.kapitel.map((k) => ({
      id: k.id, titel: k.titel, icon: k.icon,
      anzahl: k.fotos.length,
      seiten: k.seiten.map((s) => ({
        vorlage: {
          id: s.vorlage.id,
          spalten: s.vorlage.spalten,
          zeilen: s.vorlage.zeilen,
          bereiche: s.vorlage.bereiche,
        },
        fotos: s.fotos.map((f) => ({
          id: f.id,
          uploader: f.uploader,
          caption: f.caption || '',
          zeit: f.effective_at || f.uploaded_at,
          w: f.width, h: f.height,
        })),
      })),
    })),
  };
}

/* Durchnummeriertes ZIP für Druckdienste.
 *
 * Die Anbieter befüllen ihre Vorlagen in Dateinamen-Reihenfolge – deshalb
 * stehen Kapitel- und Bildnummer vorne. Originale, wo vorhanden.
 */
export function zipSchreiben(res, cfg) {
  const p = plan(cfg);
  const archive = archiver('zip', { store: true });
  archive.on('error', () => res.destroy());
  archive.pipe(res);

  p.kapitel.forEach((k, ki) => {
    const kn = String(ki + 1).padStart(2, '0');
    const kname = k.titel.replace(/[^\w\-äöüÄÖÜß ]/g, '').trim().replace(/\s+/g, '-');
    k.fotos.forEach((f, fi) => {
      const bn = String(fi + 1).padStart(3, '0');
      const wer = (f.uploader || 'gast').replace(/[^\w\-äöüÄÖÜß]/g, '_');
      const ext = f.has_original ? f.ext_original : 'jpg';
      const quelle = f.has_original
        ? path.join(db.dirs.photos, `${f.id}-o.${f.ext_original}`)
        : path.join(db.dirs.photos, `${f.id}-d.jpg`);
      if (fs.existsSync(quelle)) {
        archive.file(quelle, { name: `${kn}_${kname}/${kn}-${bn}_${wer}.${ext}` });
      }
    });
  });

  // Ein Inhaltsverzeichnis hilft beim Zusammenstellen im Druckwerkzeug.
  const inhalt = [
    p.einstellungen.titel,
    p.einstellungen.untertitel,
    '',
    `${p.fotos} Aufnahmen in ${p.kapitel.length} Kapiteln`,
    '',
    ...p.kapitel.map((k, i) =>
      `${String(i + 1).padStart(2, '0')}  ${k.titel}  –  ${k.fotos.length} Bilder`),
  ].join('\n');
  archive.append(inhalt, { name: '00_Inhalt.txt' });

  archive.finalize();
}

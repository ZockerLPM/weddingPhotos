/* Seitenvorlagen fürs Fotobuch.
 *
 * Ein gleichmässiges Raster wirkt wie ein Kontaktabzug. Was ein Buch
 * lebendig macht, sind wechselnde Aufteilungen: ein grosses Bild neben
 * zwei kleinen, ein ganzseitiges dazwischen, dann wieder ein ruhiger
 * Vierer. Genau das machen diese Vorlagen.
 *
 * Jede Vorlage ist ein CSS-Grid. `bereiche` sind die Zeilen von
 * grid-template-areas, `formen` sagt je Platz, welches Seitenverhältnis
 * dorthin passt – damit ein Hochformat nicht in einen breiten Platz
 * gequetscht wird.
 */

export const VORLAGEN = [
  { id: 'voll', n: 1, spalten: 1, zeilen: 1,
    bereiche: ['a'], formen: ['egal'] },

  { id: 'zwei', n: 2, spalten: 2, zeilen: 1,
    bereiche: ['a b'], formen: ['egal', 'egal'] },

  { id: 'hoch2', n: 2, spalten: 2, zeilen: 1,
    bereiche: ['a b'], formen: ['hoch', 'hoch'] },

  { id: 'gross2', n: 3, spalten: 3, zeilen: 2,
    bereiche: ['a a b', 'a a c'], formen: ['breit', 'egal', 'egal'] },

  { id: 'streifen', n: 3, spalten: 3, zeilen: 1,
    bereiche: ['a b c'], formen: ['hoch', 'hoch', 'hoch'] },

  { id: 'oben3', n: 4, spalten: 3, zeilen: 3,
    bereiche: ['a a a', 'a a a', 'b c d'],
    formen: ['breit', 'egal', 'egal', 'egal'] },

  { id: 'vier', n: 4, spalten: 2, zeilen: 2,
    bereiche: ['a b', 'c d'], formen: ['egal', 'egal', 'egal', 'egal'] },

  { id: 'gross4', n: 5, spalten: 4, zeilen: 2,
    bereiche: ['a a b c', 'a a d e'],
    formen: ['breit', 'egal', 'egal', 'egal', 'egal'] },

  { id: 'sechs', n: 6, spalten: 3, zeilen: 2,
    bereiche: ['a b c', 'd e f'],
    formen: ['egal', 'egal', 'egal', 'egal', 'egal', 'egal'] },
];

const nach = (id) => VORLAGEN.find((v) => v.id === id);

/* Wie abwechslungsreich soll es sein?
 *
 * „ruhig" bleibt beim Raster mit gelegentlich einem grossen Bild,
 * „lebhaft" nutzt alle Vorlagen. Die Reihenfolge ist bewusst
 * festgeschrieben statt zufällig – ein Buch soll bei jedem Aufschlagen
 * gleich aussehen, und ein Zufallsgenerator erzeugt zu oft zwei fast
 * gleiche Seiten hintereinander.
 */
const REIGEN = {
  ruhig: ['vier', 'vier', 'gross2', 'vier', 'sechs', 'vier'],
  gemischt: ['gross2', 'vier', 'oben3', 'sechs', 'gross4', 'vier', 'zwei', 'gross2'],
  lebhaft: ['gross2', 'voll', 'oben3', 'gross4', 'streifen', 'sechs',
            'zwei', 'gross2', 'vier', 'voll'],
};

const istHoch = (f) => (f.height || 0) > (f.width || 0) * 1.1;
const istBreit = (f) => (f.width || 0) > (f.height || 0) * 1.1;

// Passt die Gruppe zur Vorlage? Zählt, wie viele Plätze wirklich bedient
// werden können – „egal" passt immer.
function guete(vorlage, gruppe) {
  let punkte = 0;
  for (let i = 0; i < vorlage.formen.length; i++) {
    const form = vorlage.formen[i];
    if (form === 'egal') { punkte += 1; continue; }
    const passend = gruppe.some(
      (f) => (form === 'hoch' ? istHoch(f) : istBreit(f)));
    punkte += passend ? 1 : 0;
  }
  return punkte / vorlage.formen.length;
}

/* Die Bilder so auf die Plätze verteilen, dass die Form stimmt.
 *
 * Ein Hochformat im breiten Heldenplatz wird beschnitten und sieht
 * schlecht aus – deshalb bekommt jeder geforderte Platz zuerst ein
 * passendes Bild, der Rest füllt der Reihe nach auf.
 */
function verteilen(vorlage, gruppe) {
  const rest = gruppe.slice();
  const plaetze = new Array(vorlage.formen.length).fill(null);

  vorlage.formen.forEach((form, i) => {
    if (form === 'egal') return;
    const treffer = rest.findIndex(
      (f) => (form === 'hoch' ? istHoch(f) : istBreit(f)));
    if (treffer >= 0) plaetze[i] = rest.splice(treffer, 1)[0];
  });

  for (let i = 0; i < plaetze.length; i++) {
    if (!plaetze[i]) plaetze[i] = rest.shift() || null;
  }
  return plaetze.filter(Boolean);
}

/* Eine Kapitel-Bilderliste in Seiten schneiden.
 *
 * modus: 'raster' – gleichmässig, proSeite Bilder je Seite
 *        'collage' – wechselnde Vorlagen aus dem gewählten Reigen
 */
export function seitenBauen(fotos, modus, proSeite, abwechslung) {
  const seiten = [];

  if (modus !== 'collage') {
    const n = [1, 2, 4, 6].includes(proSeite) ? proSeite : 4;
    const vorlage = nach(n === 1 ? 'voll' : n === 2 ? 'zwei' : n === 4 ? 'vier' : 'sechs');
    for (let i = 0; i < fotos.length; i += n) {
      const gruppe = fotos.slice(i, i + n);
      seiten.push({
        vorlage: { ...vorlage, n: gruppe.length },
        fotos: gruppe,
      });
    }
    return seiten;
  }

  const reigen = (REIGEN[abwechslung] || REIGEN.gemischt).map(nach).filter(Boolean);
  let pos = 0;
  let dran = 0;

  while (pos < fotos.length) {
    const uebrig = fotos.length - pos;

    // Aus den nächsten drei Vorlagen die nehmen, die passt und deren
    // Bilderformen am besten zur anstehenden Gruppe passen.
    let gewaehlt = null;
    let beste = -1;
    for (let k = 0; k < 3; k++) {
      const v = reigen[(dran + k) % reigen.length];
      if (v.n > uebrig) continue;
      const g = guete(v, fotos.slice(pos, pos + v.n));
      if (g > beste) { beste = g; gewaehlt = v; dran = dran + k + 1; }
    }

    // Am Ende bleibt weniger übrig als jede Vorlage braucht – dann die
    // grösste passende nehmen, notfalls die einteilige.
    if (!gewaehlt) {
      gewaehlt = VORLAGEN
        .filter((v) => v.n <= uebrig)
        .sort((a, b) => b.n - a.n)[0] || nach('voll');
      dran++;
    }

    const gruppe = fotos.slice(pos, pos + gewaehlt.n);
    seiten.push({ vorlage: gewaehlt, fotos: verteilen(gewaehlt, gruppe) });
    pos += gewaehlt.n;
  }

  return seiten;
}

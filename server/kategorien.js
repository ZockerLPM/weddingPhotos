/* Kategorien für Fotos und Videos.
 *
 * Aufbau bewusst wie bei den Foto-Aufgaben: Standardliste hier, aktive
 * Liste in der settings-Tabelle, änderbar über die Moderation. Die id
 * landet in photos.category – wer eine id ändert, kappt die Verbindung
 * zu bereits zugeordneten Fotos. Der Name ist dagegen frei änderbar.
 */

// Am Ablauf einer Feier entlang sortiert, damit die Filterleiste in der
// Galerie eine sinnvolle Reihenfolge hat.
export const DEFAULT_KATEGORIEN = [
  { id: 'ankunft',   icon: '🚗', name: 'Ankunft' },
  { id: 'trauung',   icon: '💍', name: 'Trauung' },
  { id: 'gruppe',    icon: '👥', name: 'Gruppenfotos' },
  { id: 'aperitif',  icon: '🥂', name: 'Aperitif' },
  { id: 'essen',     icon: '🍽️', name: 'Essen' },
  { id: 'reden',     icon: '🎤', name: 'Reden' },
  { id: 'torte',     icon: '🎂', name: 'Torte' },
  { id: 'geschenke', icon: '🎁', name: 'Geschenke' },
  { id: 'tanz',      icon: '💃', name: 'Tanz' },
  { id: 'gaeste',    icon: '😄', name: 'Gäste' },
  { id: 'deko',      icon: '🌸', name: 'Deko & Details' },
];

export const MAX_KATEGORIEN = 24;

export function sanitizeKategorien(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  const seen = new Set();

  for (const raw of input.slice(0, MAX_KATEGORIEN)) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name) continue;

    const icon = String(raw.icon || '').trim().slice(0, 8) || '📁';
    let id = String(raw.id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
    if (!id) id = 'k' + Math.random().toString(36).slice(2, 9);
    while (seen.has(id)) id = id.slice(0, 32) + '-' + Math.random().toString(36).slice(2, 5);
    seen.add(id);

    out.push({ id, icon, name });
  }
  return out;
}

/* Foto-Aufgaben: Standardliste und Validierung.
 *
 * Die Liste liegt zur Laufzeit in der settings-Tabelle und ist über die
 * Moderation änderbar. Die ids landen in photos.challenge_id – wer eine
 * id ändert, kappt die Verbindung zu bereits hochgeladenen Fotos.
 */

// Bewusst auf eine kleine Runde zugeschnitten: keine Aufgaben, die viele
// fremde Gäste voraussetzen, sondern solche, die Nähe zeigen.
export const DEFAULT_CHALLENGES = [
  { id: 'lachen',   icon: '😄', text: 'Jemand, der gerade lacht' },
  { id: 'moment',   icon: '✨', text: 'Der schönste Moment, den du heute gesehen hast' },
  { id: 'haende',   icon: '🤝', text: 'Die Hände deines Tischnachbarn' },
  { id: 'detail',   icon: '🔍', text: 'Etwas, das nur du bemerkt hast' },
  { id: 'selfie',   icon: '🤳', text: 'Ein Selfie mit jemandem, den du zu selten siehst' },
  { id: 'heimlich', icon: '🙈', text: 'Das Brautpaar, wenn es nicht merkt, dass du fotografierst' },
  { id: 'teller',   icon: '🍽️', text: 'Was gerade auf deinem Teller liegt' },
  { id: 'fenster',  icon: '🪟', text: 'Der Blick aus dem Fenster, genau jetzt' },
];

export const MAX_CHALLENGES = 20;

// Nimmt die Liste aus der Moderation entgegen und putzt sie:
// leere Zeilen raus, Längen begrenzen, doppelte ids auflösen.
export function sanitizeChallenges(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  const seen = new Set();

  for (const raw of input.slice(0, MAX_CHALLENGES)) {
    if (!raw || typeof raw !== 'object') continue;
    const text = String(raw.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!text) continue;

    const icon = String(raw.icon || '').trim().slice(0, 8) || '📷';
    let id = String(raw.id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
    if (!id) id = 'a' + Math.random().toString(36).slice(2, 9);
    while (seen.has(id)) id = id.slice(0, 32) + '-' + Math.random().toString(36).slice(2, 5);
    seen.add(id);

    out.push({ id, icon, text });
  }
  return out;
}

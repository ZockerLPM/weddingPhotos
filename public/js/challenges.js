/* Foto-Aufgaben für den Abend.
 *
 * Bewusst auf eine kleine Runde zugeschnitten: keine Aufgaben, die viele
 * fremde Gäste voraussetzen, sondern solche, die Nähe zeigen. Alle
 * Aufgaben sind dauerhaft sichtbar und zum Abhaken – bei wenigen Gästen
 * geht es darum, überhaupt genug Material zu bekommen.
 *
 * Die id landet in der Datenbank (Spalte challenge_id) und wird für die
 * Auszeichnung "Aufgabenjäger" ausgewertet. IDs nie nachträglich ändern.
 */
window.CHALLENGES = [
  { id: 'lachen',   icon: '😄', text: 'Jemand, der gerade lacht' },
  { id: 'moment',   icon: '✨', text: 'Der schönste Moment, den du heute gesehen hast' },
  { id: 'haende',   icon: '🤝', text: 'Die Hände deines Tischnachbarn' },
  { id: 'detail',   icon: '🔍', text: 'Etwas, das nur du bemerkt hast' },
  { id: 'selfie',   icon: '🤳', text: 'Ein Selfie mit jemandem, den du zu selten siehst' },
  { id: 'heimlich', icon: '🙈', text: 'Das Brautpaar, wenn es nicht merkt, dass du fotografierst' },
  { id: 'teller',   icon: '🍽️', text: 'Was gerade auf deinem Teller liegt' },
  { id: 'fenster',  icon: '🪟', text: 'Der Blick aus dem Fenster, genau jetzt' },
];

window.challengeById = function (id) {
  if (!id) return null;
  for (var i = 0; i < window.CHALLENGES.length; i++) {
    if (window.CHALLENGES[i].id === id) return window.CHALLENGES[i];
  }
  return null;
};

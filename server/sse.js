import * as db from './db.js';

// Server-Sent Events: ein Kanal für Fotowand, Moderation und Galerie.
// Jedes Event bekommt die events.seq als ID – Browser schicken beim
// Reconnect automatisch "Last-Event-ID" mit, verpasste Events werden
// aus der Datenbank nachgeliefert.

const clients = new Set();

const fmt = (id, type, data) => `id: ${id}\nevent: ${type}\ndata: ${data}\n\n`;

export function handle(req, res) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Header hat Vorrang: bei Reconnects bleibt die alte URL (?after=...)
  // stehen, aber der Browser schickt die aktuellste ID im Header.
  const raw = req.get('last-event-id') ?? req.query.after;
  const after = Number(raw);
  if (Number.isFinite(after)) {
    for (const e of db.eventsAfter(after)) {
      res.write(fmt(e.seq, e.type, e.payload));
    }
  }
  res.write(': hello\n\n');

  clients.add(res);
  req.on('close', () => clients.delete(res));
}

export function emit(type, obj) {
  const payload = JSON.stringify(obj);
  const seq = db.addEvent(type, payload);
  const msg = fmt(seq, type, payload);
  for (const c of clients) {
    try { c.write(msg); } catch { /* Verbindung tot, close-Handler räumt auf */ }
  }
}

// Heartbeat, damit Proxies und Mobilfunk-NAT die Verbindung nicht kappen.
setInterval(() => {
  for (const c of clients) {
    try { c.write(': ping\n\n'); } catch { /* s.o. */ }
  }
}, 20000).unref();

export function clientCount() { return clients.size; }

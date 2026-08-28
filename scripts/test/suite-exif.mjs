/* Prüft public/js/exif.js gegen selbst gebaute JPEGs mit bekanntem EXIF. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { jpegWithExif, jpegWithoutExif } from './make-jpeg.mjs';

export const name = 'EXIF-Aufnahmezeit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXIF_JS = path.join(__dirname, '..', '..', 'public', 'js', 'exif.js');

// Minimales File-Objekt: der Parser braucht nur slice() und arrayBuffer().
function fakeFile(buf, lastModified) {
  return {
    lastModified,
    slice(a, b) {
      const part = buf.subarray(a, Math.min(b, buf.length));
      return { arrayBuffer: () => Promise.resolve(
        part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength)) };
    },
  };
}

function loadParser() {
  const sandbox = { window: {}, Date, Math, isFinite, String, Promise, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(EXIF_JS, 'utf8'), sandbox);
  return sandbox.window.readCaptureTime;
}

export default async function run({ ok }) {
  const readCaptureTime = loadParser();
  const LM = new Date('2026-08-16T12:00:00Z').getTime();   // "Dateidatum"

  // --- DateTimeOriginal wird gelesen
  let r = await readCaptureTime(fakeFile(
    jpegWithExif({ original: '2026:08:15 21:30:00' }), LM));
  let d = new Date(r.ts);
  ok('DateTimeOriginal wird gelesen', r.source === 'exif', 'source=' + r.source);
  ok('Datum stimmt', d.getFullYear() === 2026 && d.getMonth() === 7 && d.getDate() === 15,
    d.toString());
  ok('Uhrzeit stimmt (Ortszeit)', d.getHours() === 21 && d.getMinutes() === 30,
    d.getHours() + ':' + d.getMinutes());
  ok('Dateidatum wird ignoriert, wenn EXIF da ist', r.ts !== LM);

  // --- Zeitzone aus OffsetTimeOriginal
  r = await readCaptureTime(fakeFile(
    jpegWithExif({ original: '2026:08:15 21:30:00', offset: '+02:00' }), LM));
  ok('Zeitzonen-Offset wird berücksichtigt',
    r.ts === Date.UTC(2026, 7, 15, 19, 30, 0),
    new Date(r.ts).toISOString());

  // --- Big-Endian ("MM") wird ebenso verstanden
  r = await readCaptureTime(fakeFile(
    jpegWithExif({ original: '2026:08:15 21:30:00', littleEndian: false }), LM));
  ok('Motorola-Bytereihenfolge wird verstanden',
    r.source === 'exif' && new Date(r.ts).getHours() === 21, 'source=' + r.source);

  // --- Altfoto von 1995
  r = await readCaptureTime(fakeFile(
    jpegWithExif({ original: '1995:07:14 15:00:00' }), LM));
  ok('Altes Aufnahmedatum wird korrekt gelesen',
    new Date(r.ts).getFullYear() === 1995, new Date(r.ts).toISOString());

  // --- Rückfall auf DateTimeDigitized, dann auf IFD0-DateTime
  r = await readCaptureTime(fakeFile(
    jpegWithExif({ digitized: '2003:05:02 11:00:00' }), LM));
  ok('DateTimeDigitized als Rückfall', r.source === 'exif-scan'
    && new Date(r.ts).getFullYear() === 2003, 'source=' + r.source);

  r = await readCaptureTime(fakeFile(
    jpegWithExif({ dateTime: '2010:01:02 08:00:00' }), LM));
  ok('IFD0-DateTime als letzter EXIF-Rückfall', r.source === 'exif-datei'
    && new Date(r.ts).getFullYear() === 2010, 'source=' + r.source);

  // --- Reihenfolge der Bevorzugung
  r = await readCaptureTime(fakeFile(jpegWithExif({
    original: '2026:08:15 21:30:00',
    digitized: '2020:01:01 10:00:00',
    dateTime: '2010:01:01 10:00:00',
  }), LM));
  ok('DateTimeOriginal hat Vorrang',
    r.source === 'exif' && new Date(r.ts).getFullYear() === 2026);

  // --- Ohne EXIF: Rückfall auf das Dateidatum
  r = await readCaptureTime(fakeFile(jpegWithoutExif(), LM));
  ok('Ohne EXIF greift das Dateidatum', r.source === 'datei' && r.ts === LM,
    'source=' + r.source);

  // --- Kaputte und unsinnige Eingaben
  r = await readCaptureTime(fakeFile(Buffer.from([0x00, 0x01, 0x02, 0x03]), LM));
  ok('Nicht-JPEG stürzt nicht ab', r.source === 'datei' && r.ts === LM);

  r = await readCaptureTime(fakeFile(
    jpegWithExif({ original: '0000:00:00 00:00:00' }), LM));
  ok('Leerer EXIF-Zeitstempel wird verworfen', r.source === 'datei', 'source=' + r.source);

  r = await readCaptureTime(fakeFile(
    jpegWithExif({ original: 'kein Datum' }), LM));
  ok('Unlesbarer Zeitstempel wird verworfen', r.source === 'datei', 'source=' + r.source);

  r = await readCaptureTime(fakeFile(
    jpegWithExif({ original: '2099:01:01 10:00:00' }), LM));
  ok('Datum weit in der Zukunft wird verworfen', r.source === 'datei', 'source=' + r.source);

  const abgeschnitten = jpegWithExif({ original: '2026:08:15 21:30:00' }).subarray(0, 12);
  r = await readCaptureTime(fakeFile(abgeschnitten, LM));
  ok('Abgeschnittene Datei stürzt nicht ab', r.source === 'datei');
}

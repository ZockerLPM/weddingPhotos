/* Baut minimale, aber gültige JPEGs mit echtem EXIF-Block – damit lässt
 * sich der Parser gegen bekannte Werte prüfen, ohne Testbilder im Repo.
 */

// Ein winziges, dekodierbares 1x1-JPEG als Grundgerüst.
const BASE = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////' +
  '////////////////////////////////////////////////////wgALCAABAAEBAREA/8QA' +
  'FBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

// EXIF-APP1-Segment mit DateTimeOriginal (und optional Zeitzone) bauen.
export function exifSegment({ original, digitized, dateTime, offset, littleEndian = true }) {
  const entries = [];   // { tag, value } – alles ASCII
  if (dateTime) entries.push({ ifd: 0, tag: 0x0132, value: dateTime });
  if (original) entries.push({ ifd: 1, tag: 0x9003, value: original });
  if (digitized) entries.push({ ifd: 1, tag: 0x9004, value: digitized });
  if (offset) entries.push({ ifd: 1, tag: 0x9011, value: offset });

  const ifd0 = entries.filter(e => e.ifd === 0);
  const exif = entries.filter(e => e.ifd === 1);

  const le = littleEndian;
  const bufs = [];
  const u16 = (v) => { const b = Buffer.alloc(2); le ? b.writeUInt16LE(v) : b.writeUInt16BE(v); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); le ? b.writeUInt32LE(v) : b.writeUInt32BE(v); return b; };

  // TIFF-Header
  bufs.push(Buffer.from(le ? 'II' : 'MM', 'ascii'), u16(42), u32(8));

  // Platz berechnen: IFD0 (mit Exif-Zeiger) danach Exif-IFD, dann Datenbereich.
  const ifd0Count = ifd0.length + (exif.length ? 1 : 0);
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const exifOff = 8 + ifd0Size;
  const exifSize = exif.length ? 2 + exif.length * 12 + 4 : 0;
  let dataOff = exifOff + exifSize;

  const dataBufs = [];
  const place = (value) => {
    const b = Buffer.from(value + '\0', 'ascii');
    if (b.length <= 4) {
      const inline = Buffer.alloc(4);
      b.copy(inline);
      return { len: b.length, inline };
    }
    const at = dataOff;
    dataBufs.push(b);
    dataOff += b.length;
    return { len: b.length, offset: at };
  };

  const entryBuf = (tag, value) => {
    const p = place(value);
    return Buffer.concat([u16(tag), u16(2), u32(p.len), p.inline || u32(p.offset)]);
  };

  // Reihenfolge: erst alle Werte platzieren, dann Einträge schreiben.
  const ifd0Entries = ifd0.map(e => entryBuf(e.tag, e.value));
  if (exif.length) {
    ifd0Entries.push(Buffer.concat([u16(0x8769), u16(4), u32(1), u32(exifOff)]));
  }
  const exifEntries = exif.map(e => entryBuf(e.tag, e.value));

  bufs.push(u16(ifd0Count), ...ifd0Entries, u32(0));
  if (exif.length) bufs.push(u16(exif.length), ...exifEntries, u32(0));
  bufs.push(...dataBufs);

  const tiff = Buffer.concat(bufs);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const size = payload.length + 2;
  return Buffer.concat([Buffer.from([0xFF, 0xE1, size >> 8, size & 0xFF]), payload]);
}

// JPEG mit eingesetztem EXIF-Segment direkt nach SOI.
export function jpegWithExif(opts) {
  return Buffer.concat([BASE.subarray(0, 2), exifSegment(opts), BASE.subarray(2)]);
}

export const jpegWithoutExif = () => Buffer.from(BASE);

/* Aufnahmezeitpunkt aus den Metadaten lesen.
 *
 * file.lastModified ist der Zeitpunkt, zu dem die DATEI entstanden ist –
 * bei einem über einen Messenger weitergeleiteten Bild also der Download,
 * nicht die Aufnahme. EXIF DateTimeOriginal ist der echte Auslösezeitpunkt
 * und steckt in praktisch jedem Kamera- und Handyfoto.
 *
 * Bewusst ein eigener Mini-Parser statt einer Bibliothek: gebraucht werden
 * genau fünf ASCII-Felder, und das Projekt kommt ohne Build-Schritt aus.
 */
(function () {
  'use strict';

  var HEAD_BYTES = 256 * 1024;   // EXIF steht immer am Dateianfang

  var TAG = {
    DATE_TIME:        0x0132,  // IFD0, letzte Änderung
    EXIF_POINTER:     0x8769,
    DATE_ORIGINAL:    0x9003,  // Auslösezeitpunkt – das wollen wir
    DATE_DIGITIZED:   0x9004,
    OFFSET_ORIGINAL:  0x9011,  // Zeitzone, z. B. "+02:00"
    OFFSET_DIGITIZED: 0x9012,
  };

  // Eine IFD-Tabelle durchgehen und die interessanten ASCII-Felder sammeln.
  function walkIFD(dv, tiff, ifdOff, le, out, depth) {
    if (depth > 2 || ifdOff < 0 || ifdOff + 2 > dv.byteLength) return;
    var count = dv.getUint16(ifdOff, le);
    if (count > 512) return;                      // unplausibel -> kaputt

    for (var i = 0; i < count; i++) {
      var e = ifdOff + 2 + i * 12;
      if (e + 12 > dv.byteLength) return;

      var tag = dv.getUint16(e, le);
      var type = dv.getUint16(e + 2, le);
      var len = dv.getUint32(e + 4, le);

      if (tag === TAG.EXIF_POINTER) {
        walkIFD(dv, tiff, tiff + dv.getUint32(e + 8, le), le, out, depth + 1);
        continue;
      }
      if (type !== 2) continue;                   // nur ASCII interessiert
      if (tag !== TAG.DATE_TIME && tag !== TAG.DATE_ORIGINAL &&
          tag !== TAG.DATE_DIGITIZED && tag !== TAG.OFFSET_ORIGINAL &&
          tag !== TAG.OFFSET_DIGITIZED) continue;

      // Bis 4 Byte steht der Wert direkt im Eintrag, sonst ist es ein Offset.
      var vOff = len <= 4 ? e + 8 : tiff + dv.getUint32(e + 8, le);
      if (vOff < 0 || vOff + len > dv.byteLength) continue;

      var s = '';
      for (var k = 0; k < len; k++) {
        var c = dv.getUint8(vOff + k);
        if (!c) break;
        s += String.fromCharCode(c);
      }
      out[tag] = s.trim();
    }
  }

  function readTiff(dv, start, out) {
    if (start + 8 > dv.byteLength) return;
    var bom = dv.getUint16(start);
    var le;
    if (bom === 0x4949) le = true;              // "II" Intel
    else if (bom === 0x4D4D) le = false;        // "MM" Motorola
    else return;
    if (dv.getUint16(start + 2, le) !== 42) return;
    walkIFD(dv, start, start + dv.getUint32(start + 4, le), le, out, 0);
  }

  // JPEG-Segmente durchlaufen, bis das APP1-Segment mit "Exif\0\0" kommt.
  function findExif(buf) {
    var dv = new DataView(buf);
    var out = {};
    if (dv.byteLength < 4 || dv.getUint16(0) !== 0xFFD8) return out;  // kein JPEG

    var off = 2;
    while (off + 4 <= dv.byteLength) {
      if (dv.getUint8(off) !== 0xFF) { off++; continue; }
      var marker = dv.getUint8(off + 1);
      if (marker === 0xD8 || marker === 0x01 ||
          (marker >= 0xD0 && marker <= 0xD7)) { off += 2; continue; }
      if (marker === 0xDA || marker === 0xD9) break;      // ab hier Bilddaten

      var size = dv.getUint16(off + 2);
      if (size < 2) break;

      if (marker === 0xE1) {                                // APP1
        if (off + 10 <= dv.byteLength &&
            dv.getUint32(off + 4) === 0x45786966 &&      // "Exif"
            dv.getUint16(off + 8) === 0) {
          readTiff(dv, off + 10, out);
          break;
        }
      }
      off += 2 + size;
    }
    return out;
  }

  // "2026:08:16 21:30:00" (+ optionale Zone) in einen Zeitstempel wandeln.
  function toTimestamp(text, offset) {
    var m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text || '');
    if (!m) return null;
    var Y = +m[1], Mo = +m[2], D = +m[3], H = +m[4], Mi = +m[5], S = +m[6];
    if (Y < 1900 || Mo < 1 || Mo > 12 || D < 1 || D > 31 || H > 23 || Mi > 59 || S > 60) {
      return null;
    }

    var om = /^([+-])(\d{2}):?(\d{2})$/.exec(offset || '');
    var ts;
    if (om) {
      var mins = (om[1] === '-' ? -1 : 1) * (+om[2] * 60 + +om[3]);
      ts = Date.UTC(Y, Mo - 1, D, H, Mi, S) - mins * 60000;
    } else {
      // Ohne Zonenangabe ist es Ortszeit der Kamera – für Gäste am selben
      // Ort ist die Zeitzone dieses Geräts die richtige Annahme.
      ts = new Date(Y, Mo - 1, D, H, Mi, S).getTime();
    }
    if (!isFinite(ts)) return null;
    // Aufnahmen "aus der Zukunft" sind immer ein Fehler.
    if (ts > Date.now() + 2 * 365 * 24 * 3600 * 1000) return null;
    return ts;
  }

  /* Liefert { ts, source }.
   * source: 'exif'      – DateTimeOriginal, der Auslösezeitpunkt
   *         'exif-scan' – DateTimeDigitized (etwa bei eingescannten Bildern)
   *         'exif-datei'– DateTime aus IFD0
   *         'datei'     – kein EXIF, Rückfall auf lastModified
   */
  window.readCaptureTime = function (file) {
    return file.slice(0, HEAD_BYTES).arrayBuffer()
      .then(function (buf) {
        var t = findExif(buf);
        var cands = [
          [t[TAG.DATE_ORIGINAL],  t[TAG.OFFSET_ORIGINAL],  'exif'],
          [t[TAG.DATE_DIGITIZED], t[TAG.OFFSET_DIGITIZED], 'exif-scan'],
          [t[TAG.DATE_TIME],      null,                    'exif-datei'],
        ];
        for (var i = 0; i < cands.length; i++) {
          var ts = toTimestamp(cands[i][0], cands[i][1]);
          if (ts) return { ts: ts, source: cands[i][2] };
        }
        return { ts: file.lastModified || null, source: 'datei' };
      })
      .catch(function () {
        return { ts: file.lastModified || null, source: 'datei' };
      });
  };
})();

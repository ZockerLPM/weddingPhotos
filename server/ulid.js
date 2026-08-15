import crypto from 'node:crypto';

// ULID: 10 Zeichen Zeitstempel (ms) + 16 Zeichen Zufall, Crockford-Base32.
// Zeitlich sortierbar – die Foto-IDs sind damit gleichzeitig die Upload-Reihenfolge.
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(time = Date.now()) {
  const chars = new Array(26);
  let n = time;
  for (let i = 9; i >= 0; i--) {
    chars[i] = ENC[n % 32];
    n = Math.floor(n / 32);
  }
  const bytes = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) {
    chars[10 + i] = ENC[bytes[i] % 32];
  }
  return chars.join('');
}

// RFC 6238 TOTP (the codes Google Authenticator & co. show), RFC 4648 base32.

import crypto from 'node:crypto';

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHA[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHA[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = ALPHA.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function hotp(secret, counter, digits = 6) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = h[h.length - 1] & 15;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totp(secret, now = Date.now(), step = 30) {
  return hotp(secret, Math.floor(now / 1000 / step));
}

// Returns the matched time step (for replay protection) or -1. Accepts one
// step of clock drift either way.
export function verifyTotp(secret, code, now = Date.now(), step = 30) {
  if (!/^\d{6}$/.test(String(code ?? ''))) return -1;
  const t = Math.floor(now / 1000 / step);
  for (const d of [0, -1, 1]) {
    if (t + d < 0) continue;
    const expected = hotp(secret, t + d);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(code)))) return t + d;
  }
  return -1;
}

export function otpauthUri(secret, account, issuer = 'Primordial Soup') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&period=30&digits=6`;
}

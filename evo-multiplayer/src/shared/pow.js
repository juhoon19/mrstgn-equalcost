// Registration proof of work (browser and Node share this file).
//
// The gateway hands out a signed challenge; the client must find a nonce so
// that SHA-256(challenge + ":" + nonce) starts with `bits` zero bits. At the
// default 16 bits that is ~65k hashes: a second or two for one person, but
// real CPU for whoever wants ten thousand alt accounts. It complements the
// per-IP registration limit (which a botnet spreads out); it is not a
// CAPTCHA and does not stop a determined, well-funded farm.

function leadingZeroBits(bytes) {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

const enc = new TextEncoder();

export async function powHash(challenge, nonce) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${challenge}:${nonce}`)));
}

export async function powCheck(challenge, nonce, bits) {
  if (!Number.isSafeInteger(nonce) || nonce < 0) return false;
  return leadingZeroBits(await powHash(challenge, nonce)) >= bits;
}

// onProgress(tries) is called now and then (UI); returns the nonce.
export async function powSolve(challenge, bits, onProgress = () => {}) {
  for (let nonce = 0; ; nonce++) {
    if (leadingZeroBits(await powHash(challenge, nonce)) >= bits) return nonce;
    if (nonce % 4096 === 4095) onProgress(nonce + 1);
  }
}

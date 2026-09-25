// Minimal binary writer/reader shared by server, browser and bots.
// No Node-only APIs: everything is Uint8Array/DataView so the same file is
// served to the browser unchanged.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class Writer {
  constructor(capacity = 1024) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
    this.pos = 0;
  }

  reset() {
    this.pos = 0;
    return this;
  }

  ensure(n) {
    const need = this.pos + n;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v) {
    this.ensure(1);
    this.buf[this.pos++] = v;
    return this;
  }

  u16(v) {
    this.ensure(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
    return this;
  }

  u24(v) {
    this.ensure(3);
    this.buf[this.pos++] = v & 0xff;
    this.buf[this.pos++] = (v >>> 8) & 0xff;
    this.buf[this.pos++] = (v >>> 16) & 0xff;
    return this;
  }

  u32(v) {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
    return this;
  }

  f32(v) {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
    return this;
  }

  // Unsigned LEB128, valid for 0 <= v < 2^53.
  varint(v) {
    this.ensure(8);
    while (v >= 0x80) {
      this.buf[this.pos++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.pos++] = v;
    return this;
  }

  // Zigzag-encoded signed varint (small magnitudes stay one byte).
  svarint(v) {
    return this.varint(v >= 0 ? v * 2 : -v * 2 - 1);
  }

  bytes(arr) {
    this.ensure(arr.length);
    this.buf.set(arr, this.pos);
    this.pos += arr.length;
    return this;
  }

  // Length-prefixed UTF-8, truncated to maxBytes.
  str(s, maxBytes = 255) {
    let b = textEncoder.encode(s);
    if (b.length > maxBytes) b = b.subarray(0, maxBytes);
    this.varint(b.length);
    return this.bytes(b);
  }

  // Copy of the written bytes (safe to hand to another thread/socket).
  finish() {
    return this.buf.slice(0, this.pos);
  }
}

export class Reader {
  constructor(data) {
    this.buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.pos = 0;
  }

  get remaining() {
    return this.buf.length - this.pos;
  }

  check(n) {
    if (this.pos + n > this.buf.length) throw new RangeError('read past end');
  }

  u8() {
    this.check(1);
    return this.buf[this.pos++];
  }

  u16() {
    this.check(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u24() {
    this.check(3);
    const b = this.buf;
    const v = b[this.pos] | (b[this.pos + 1] << 8) | (b[this.pos + 2] << 16);
    this.pos += 3;
    return v;
  }

  u32() {
    this.check(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f32() {
    this.check(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  varint() {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.u8();
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 0x80;
    }
    throw new RangeError('varint too long');
  }

  svarint() {
    const v = this.varint();
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }

  bytes(n) {
    this.check(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  str(maxBytes = 255) {
    const n = this.varint();
    if (n > maxBytes) throw new RangeError('string too long');
    return textDecoder.decode(this.bytes(n));
  }
}

// Encodes what a chunk looks like for clients. Each chunk is encoded ONCE per
// network tick no matter how many gateways/clients watch it; gateways forward
// the bytes untouched. This "encode once, fan out" rule is what lets the
// number of spectators grow without growing shard CPU.
//
// Deltas are relative to the previous frame of the same chunk stream (not to
// a per-client ack as in Quake-style snapshot deltas), which is valid because
// WebSocket is reliable and ordered. A client that falls behind or joins late
// is resynchronised from a keyframe (forced on subscribe, and every
// `keyEvery` frames) plus the cached deltas since it.

import { Writer } from '../shared/codec.js';
import { S_CHUNK, S_FIELD, S_EVENTS, F_KEY, EV_CHAT, EV_ACTION, MOVE_R, MOVE_LEVEL, writeFullRecord, writeMoveRecord } from '../shared/protocol.js';
import { POS_QUANT } from '../shared/topology.js';

const writer = new Writer(64 * 1024);

class Sent {
  constructor(qx, qy, r4, level) {
    this.qx = qx;
    this.qy = qy;
    this.r4 = r4;
    this.level = level;
    this.seen = 0;
  }
}

function quant(v, max) {
  let q = Math.round(v * POS_QUANT);
  if (q < 0) q = 0;
  else if (q > max) q = max;
  return q;
}

// Level (energy bar etc.) is shown coarsely; quantising it to 16 steps
// means it rarely changes, so move records rarely carry it.
function lvl(e) {
  return e.level & 0xf0;
}

const byId = (a, b) => a.id - b.id;

export function encodeChunkFrame(chunk, chunkSize, key) {
  const ox = chunk.cx * chunkSize;
  const oy = chunk.cy * chunkSize;
  const qmax = Math.min(65535, chunkSize * POS_QUANT);
  const frameNo = ++chunk.frameNo;
  const w = writer.reset();
  // Shard wall clock (ms, u32). Clients use it to decide which chunk has the
  // newest word on an entity; keep shard clocks NTP-synced across machines.
  w.u8(S_CHUNK).varint(chunk.id).varint(frameNo).u8(key ? F_KEY : 0).u32(Date.now() % 4294967296);
  const last = chunk.lastSent;
  const ents = chunk.entities;

  if (key) {
    last.clear();
    w.varint(ents.length);
    for (const e of ents) {
      const qx = quant(e.x - ox, qmax);
      const qy = quant(e.y - oy, qmax);
      const r4 = Math.min(255, Math.round(e.r * 4));
      const l = lvl(e);
      writeFullRecord(w, e.id, e.kind, qx, qy, r4, e.rgb, e.owner, l);
      last.set(e.id, new Sent(qx, qy, r4, l));
    }
    return w.finish();
  }

  const mark = frameNo;
  const added = [];
  const moved = [];
  for (const e of ents) {
    const qx = quant(e.x - ox, qmax);
    const qy = quant(e.y - oy, qmax);
    const r4 = Math.min(255, Math.round(e.r * 4));
    const l = lvl(e);
    const s = last.get(e.id);
    if (!s) {
      const n = new Sent(qx, qy, r4, l);
      n.seen = mark;
      n.id = e.id;
      n.e = e;
      added.push(n);
      continue;
    }
    s.seen = mark;
    const flags = (s.r4 !== r4 ? MOVE_R : 0) | (s.level !== l ? MOVE_LEVEL : 0);
    if (s.qx !== qx || s.qy !== qy || flags) {
      moved.push({ id: e.id, dqx: qx - s.qx, dqy: qy - s.qy, flags, r4, level: l });
      s.qx = qx;
      s.qy = qy;
      s.r4 = r4;
      s.level = l;
    }
  }
  // Removed = previously sent and not seen now. Ids are sorted and
  // delta-coded so they cost about one byte each.
  const removed = [];
  for (const [id, s] of last) {
    if (s.seen !== mark) {
      removed.push(id);
      last.delete(id);
    }
  }
  removed.sort((a, b) => a - b);
  w.varint(removed.length);
  let prev = 0;
  for (const id of removed) {
    w.varint(id - prev);
    prev = id;
  }
  w.varint(added.length);
  for (const n of added) {
    writeFullRecord(w, n.id, n.e.kind, n.qx, n.qy, n.r4, n.e.rgb, n.e.owner, n.level);
    n.e = null;
    last.set(n.id, n);
  }
  moved.sort(byId);
  w.varint(moved.length);
  prev = 0;
  for (const m of moved) {
    writeMoveRecord(w, m.id - prev, m.dqx, m.dqy, m.flags, m.r4, m.level);
    prev = m.id;
  }
  return w.finish();
}

// Chemical field for display: box-downsampled to `res` x `res` per chunk and
// quantised to one byte per value on a log scale. The simulation keeps full
// resolution; clients only need a blurred background.
export function encodeField(chunk, G, C, res = G) {
  const w = writer.reset();
  const k = Math.max(1, Math.floor(G / res));
  const R = Math.floor(G / k);
  w.u8(S_FIELD).varint(chunk.id).u8(R);
  const f = chunk.field;
  w.ensure(R * R * C);
  const inv = 1 / (k * k);
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      for (let ch = 0; ch < C; ch++) {
        let sum = 0;
        for (let dy = 0; dy < k; dy++) {
          for (let dx = 0; dx < k; dx++) sum += f[((y * k + dy) * G + x * k + dx) * C + ch];
        }
        let q = Math.round(40 * Math.log2(1 + sum * inv));
        if (q > 255) q = 255;
        w.buf[w.pos++] = q;
      }
    }
  }
  return w.finish();
}

export function decodeFieldValue(q) {
  return Math.pow(2, q / 40) - 1;
}

// Cursors of players looking at / pointing into this chunk, plus one-off
// events (chat bubbles, tool effects). Returns null when there is nothing new.
export function encodeEvents(chunk, chunkSize, players, now, cursorTtl = 3000, maxCursors = 32) {
  const ox = chunk.cx * chunkSize;
  const oy = chunk.cy * chunkSize;
  const qmax = Math.min(65535, chunkSize * POS_QUANT);
  let live = 0;
  for (const [pid, c] of chunk.cursors) {
    if (now - c.t > cursorTtl) chunk.cursors.delete(pid);
    else live++;
  }
  const hadCursors = chunk.hadCursors;
  chunk.hadCursors = live > 0;
  if (live === 0 && !hadCursors && chunk.events.length === 0) return null;
  if (live > 0 && !chunk.cursorsDirty && chunk.events.length === 0 && hadCursors) return null;
  chunk.cursorsDirty = false;

  const w = writer.reset();
  w.u8(S_EVENTS).varint(chunk.id);
  const n = Math.min(live, maxCursors);
  w.varint(n);
  let k = 0;
  for (const [pid, c] of chunk.cursors) {
    if (k++ >= n) break;
    const p = players.get(pid);
    w.varint(pid).u16(quant(c.x - ox, qmax)).u16(quant(c.y - oy, qmax));
    w.u24(p ? p.rgb : 0xffffff).str(p ? p.name : '?', 48);
  }
  const evs = chunk.events.splice(0, 64);
  chunk.events.length = 0;
  w.varint(evs.length);
  for (const ev of evs) {
    w.u8(ev.kind).varint(ev.pid).u16(quant(ev.x - ox, qmax)).u16(quant(ev.y - oy, qmax));
    if (ev.kind === EV_CHAT) {
      const p = players.get(ev.pid);
      w.str(p ? p.name : '?', 48).str(ev.text, 600);
    } else if (ev.kind === EV_ACTION) {
      w.u8(ev.action).u24(ev.rgb);
    }
  }
  return w.finish();
}

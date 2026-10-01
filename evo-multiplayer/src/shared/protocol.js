// Wire protocol. Binary for the hot paths (snapshots, input), JSON text for
// rare control messages. See docs/protocol.md for the byte layouts.

import { Writer, Reader } from './codec.js';

export const PROTOCOL_VERSION = 1;

// ---- server -> client (binary, first byte) ----
export const S_CHUNK = 1; // per-chunk entity keyframe / delta (shard-encoded, forwarded as is)
export const S_FIELD = 2; // per-chunk chemical field, quantised to u8
export const S_SUMMARY = 3; // whole-world low-detail overview (minimap / zoomed-out LOD)
export const S_PONG = 4;
export const S_EVENTS = 5; // per-chunk transient cursors, chat bubbles, action effects
export const S_BATCH = 6; // several of the above in one WebSocket message

// ---- client -> server (binary, first byte) ----
export const C_VIEW = 10; // viewport rectangle
export const C_ACTION = 11; // tool use
export const C_CURSOR = 12; // pointer position (shared with nearby players)
export const C_PING = 13;

// ---- gateway <-> shard internal binary ----
export const I_CURSORS = 100;
export const I_ACTIONS = 101;
export const I_SUMMARY = 102;
export const I_MIGRATE = 110;
export const I_GHOST = 111;
export const I_XFER = 112; // chunk handoff between shards (dynamic load balancing)

// Chunk frame flags
export const F_KEY = 1;
export const F_LO = 2; // frame belongs to the low-rate stream of the chunk

// Quality tiers a client can watch a chunk at. Each tier is its own
// keyframe/delta stream, encoded once per chunk for all its watchers.
export const TIER_HI = 0; // every network tick (10 Hz)
export const TIER_LO = 1; // every 4th network tick (2.5 Hz), for zoomed-out views

// Event kinds inside S_EVENTS
export const EV_CHAT = 1;
export const EV_ACTION = 2;

// Player tools. The game module decides what each one does; the network
// layer only rate-limits and routes them to the shard owning (x, y).
export const ACTIONS = {
  NUTRIENT: 1,
  SEED: 2,
  STIR: 3,
  SIGNAL: 4,
};

// Default per-player cooldowns (ms) enforced at the gateway.
export const ACTION_COOLDOWN_MS = {
  [ACTIONS.NUTRIENT]: 250,
  [ACTIONS.SEED]: 2000,
  [ACTIONS.STIR]: 150,
  [ACTIONS.SIGNAL]: 250,
};

// ---------------------------------------------------------------------------
// Client -> server encoders (used by the browser and by bots)

export function encodeView(x0, y0, x1, y1, tier = TIER_HI) {
  return new Writer(18).u8(C_VIEW).f32(x0).f32(y0).f32(x1).f32(y1).u8(tier).finish();
}

export function encodeAction(type, x, y, dx = 0, dy = 0) {
  return new Writer(18).u8(C_ACTION).u8(type).f32(x).f32(y).f32(dx).f32(dy).finish();
}

export function encodeCursor(x, y) {
  return new Writer(9).u8(C_CURSOR).f32(x).f32(y).finish();
}

export function encodePing(n) {
  return new Writer(5).u8(C_PING).u32(n).finish();
}

// Coalescing: many small binary messages -> one WebSocket message.
// Layout: u8 S_BATCH, then repeated (varint length, bytes). Sending one
// message per client per tick instead of ~30 is the single biggest CPU win
// on the fan-out path (fewer syscalls, frame headers and callbacks).
export function packBatch(parts) {
  if (parts.length === 1) return parts[0];
  let total = 1;
  for (const p of parts) total += varintSize(p.length) + p.length;
  const out = new Uint8Array(total);
  out[0] = S_BATCH;
  let pos = 1;
  for (const p of parts) {
    let n = p.length;
    while (n >= 0x80) {
      out[pos++] = (n & 0x7f) | 0x80;
      n >>>= 7;
    }
    out[pos++] = n;
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function varintSize(n) {
  let k = 1;
  while (n >= 0x80) {
    n >>>= 7;
    k++;
  }
  return k;
}

// Calls fn(subMessage) for each message inside a batch (or once for a plain
// message). Sub-messages are views into `bytes`, not copies.
export function unpackBatch(bytes, fn) {
  if (bytes[0] !== S_BATCH) {
    fn(bytes);
    return;
  }
  const r = new Reader(bytes);
  r.u8();
  while (r.remaining > 0) {
    const n = r.varint();
    fn(r.bytes(n));
  }
}

// Reads the fixed header of an S_CHUNK / S_FIELD / S_EVENTS message without
// decoding the body. Gateways use this to route shard output untouched.
export function peekChunkHeader(bytes) {
  const r = new Reader(bytes);
  const type = r.u8();
  const chunkId = r.varint();
  if (type !== S_CHUNK) return { type, chunkId, frameNo: 0, flags: 0 };
  const frameNo = r.varint();
  const flags = r.u8();
  const time = r.u32();
  return { type, chunkId, frameNo, flags, time };
}

// ---------------------------------------------------------------------------
// Entity records inside S_CHUNK. The schema is deliberately small and generic
// so another game can reuse it: kind selects how the client draws the entity,
// the rest are visual attributes.
//
// full: varint id, u8 kind, u16 qx, u16 qy, u8 r4, u24 rgb, varint owner, u8 level
// move: varint (idDelta << 2 | flags), svarint dqx, svarint dqy,
//       [u8 r4 if flags & MOVE_R], [u8 level if flags & MOVE_LEVEL]
//       (move records are sorted by id; idDelta is from the previous record)

export const MOVE_R = 1;
export const MOVE_LEVEL = 2;

export function writeFullRecord(w, id, kind, qx, qy, r4, rgb, owner, level) {
  w.varint(id).u8(kind).u16(qx).u16(qy).u8(r4).u24(rgb).varint(owner).u8(level);
}

export function writeMoveRecord(w, idDelta, dqx, dqy, flags, r4, level) {
  w.varint(idDelta * 4 + flags).svarint(dqx).svarint(dqy);
  if (flags & MOVE_R) w.u8(r4);
  if (flags & MOVE_LEVEL) w.u8(level);
}

// ---------------------------------------------------------------------------
// Client-side replica of the chunks a client is subscribed to. Used by the
// browser renderer and by the load-test bots (which also count desyncs).
//
// Two layers:
//  * per chunk, a mirror of exactly what that chunk's stream has said
//    (`c.ents`), so deltas always apply to the right base;
//  * one render entity per id, owned by whichever chunk has the NEWEST
//    information about it (frames carry the shard's clock). Streams are not
//    ordered with respect to each other: a gateway replays a cached,
//    slightly old keyframe chain when you subscribe to a chunk, and
//    neighbouring shards hand entities over asynchronously. "Newest wins"
//    makes both harmless.

const newer = (a, b) => ((a - b) | 0) >= 0; // u32 ms clock, wrap-safe

export class ClientWorld {
  constructor(world, posQuant) {
    this.world = world;
    this.posQuant = posQuant;
    this.entities = new Map(); // id -> ClientEntity (what to draw)
    this.chunks = new Map(); // chunkId -> { frameNo, ents: Map<id, rec>, synced }
    this.fields = new Map(); // chunkId -> { data: Uint8Array, t }
    this.tombs = new Map(); // id -> server time it was removed
    this.stats = { frames: 0, keyframes: 0, deltas: 0, gaps: 0, unknownIds: 0, dupAdds: 0 };
  }

  chunkOrigin(chunkId) {
    const cx = chunkId % this.world.chunksX;
    const cy = (chunkId - cx) / this.world.chunksX;
    return [cx * this.world.chunkSize, cy * this.world.chunkSize];
  }

  dropChunk(chunkId) {
    const c = this.chunks.get(chunkId);
    if (c) {
      for (const id of c.ents.keys()) {
        const e = this.entities.get(id);
        if (e && e.chunk === chunkId) this.entities.delete(id);
      }
    }
    this.chunks.delete(chunkId);
    this.fields.delete(chunkId);
  }

  // Returns false if the frame could not be applied (needs a keyframe).
  applyChunk(bytes, now) {
    const r = new Reader(bytes);
    r.u8();
    const chunkId = r.varint();
    const frameNo = r.varint();
    const flags = r.u8();
    const T = r.u32();
    this.stats.frames++;
    this.interval = flags & F_LO ? ClientWorld.loInterval : ClientEntity.interval;
    let c = this.chunks.get(chunkId);

    if (flags & F_KEY) {
      this.stats.keyframes++;
      if (!c) {
        c = { frameNo, ents: new Map(), synced: true, t: T };
        this.chunks.set(chunkId, c);
      }
      const prev = c.ents;
      c.ents = new Map();
      c.frameNo = frameNo;
      c.synced = true;
      c.t = T;
      const n = r.varint();
      for (let i = 0; i < n; i++) {
        const rec = readFullRecord(r);
        c.ents.set(rec.id, rec);
        this.present(chunkId, rec, T, now);
      }
      for (const id of prev.keys()) if (!c.ents.has(id)) this.gone(chunkId, id, T);
      return true;
    }

    this.stats.deltas++;
    if (!c || !c.synced) return false;
    if (frameNo !== c.frameNo + 1) {
      this.stats.gaps++;
      c.synced = false;
      return false;
    }
    c.frameNo = frameNo;
    c.t = T;
    const nRemoved = r.varint();
    let prev = 0;
    for (let i = 0; i < nRemoved; i++) {
      const id = prev + r.varint();
      prev = id;
      if (!c.ents.delete(id)) this.stats.unknownIds++;
      this.gone(chunkId, id, T);
    }
    const nAdded = r.varint();
    for (let i = 0; i < nAdded; i++) {
      const rec = readFullRecord(r);
      if (c.ents.has(rec.id)) this.stats.dupAdds++;
      c.ents.set(rec.id, rec);
      this.present(chunkId, rec, T, now);
    }
    const nMoved = r.varint();
    prev = 0;
    for (let i = 0; i < nMoved; i++) {
      const head = r.varint();
      const flags = head % 4;
      const id = prev + (head - flags) / 4;
      prev = id;
      const dqx = r.svarint();
      const dqy = r.svarint();
      const r4 = flags & MOVE_R ? r.u8() : -1;
      const level = flags & MOVE_LEVEL ? r.u8() : -1;
      const rec = c.ents.get(id);
      if (!rec) {
        this.stats.unknownIds++;
        continue;
      }
      rec.qx += dqx;
      rec.qy += dqy;
      if (r4 >= 0) rec.r4 = r4;
      if (level >= 0) rec.level = level;
      this.present(chunkId, rec, T, now);
    }
    return true;
  }

  // Chunk `chunkId` says entity `rec` is in it at server time T.
  present(chunkId, rec, T, now) {
    let e = this.entities.get(rec.id);
    if (e) {
      if (e.chunk !== chunkId && !newer(T, e.srvT)) return; // stale news
    } else {
      const tomb = this.tombs.get(rec.id);
      if (tomb !== undefined) {
        if (!newer(T, tomb)) return; // removed later than this
        this.tombs.delete(rec.id);
      }
      e = new ClientEntity(rec.id);
      e.chunk = -1;
      this.entities.set(rec.id, e);
    }
    const [ox, oy] = this.chunkOrigin(chunkId);
    const x = ox + rec.qx / this.posQuant;
    const y = oy + rec.qy / this.posQuant;
    if (e.chunk === -1) {
      e.px = x;
      e.py = y;
    } else {
      // Keep the on-screen position so it glides instead of jumping.
      e.px = e.renderX(now);
      e.py = e.renderY(now);
    }
    e.chunk = chunkId;
    e.srvT = T;
    e.interval = this.interval;
    e.kind = rec.kind;
    e.x = x;
    e.y = y;
    e.t = now;
    e.r = rec.r4 / 4;
    e.rgb = rec.rgb;
    e.owner = rec.owner;
    e.level = rec.level;
  }

  // Chunk `chunkId` says entity `id` is no longer in it at server time T.
  gone(chunkId, id, T) {
    const e = this.entities.get(id);
    if (!e || e.chunk !== chunkId) return;
    this.entities.delete(id);
    this.tombs.set(id, T);
    if (this.tombs.size > 20000) {
      // Tombstones only matter for a few seconds (the replay window).
      let k = this.tombs.size - 10000;
      for (const tid of this.tombs.keys()) {
        if (k-- <= 0) break;
        this.tombs.delete(tid);
      }
    }
  }

  applyField(bytes, now) {
    const r = new Reader(bytes);
    r.u8();
    const chunkId = r.varint();
    const res = r.u8();
    const data = r.bytes(res * res * this.world.channels).slice();
    this.fields.set(chunkId, { data, res, t: now });
    return chunkId;
  }
}

function readFullRecord(r) {
  return {
    id: r.varint(),
    kind: r.u8(),
    qx: r.u16(),
    qy: r.u16(),
    r4: r.u8(),
    rgb: r.u24(),
    owner: r.varint(),
    level: r.u8(),
  };
}

// Interpolation: an entity moves from (px,py) at time t to (x,y) over one
// network interval, so the rendered world trails the server by ~1 interval.
export class ClientEntity {
  constructor(id) {
    this.id = id;
    this.chunk = -1;
    this.kind = 0;
    this.qx = 0;
    this.qy = 0;
    this.x = 0;
    this.y = 0;
    this.px = 0;
    this.py = 0;
    this.t = 0;
    this.srvT = 0;
    this.interval = ClientEntity.interval;
    this.r = 1;
    this.rgb = 0xffffff;
    this.owner = 0;
    this.level = 0;
  }

  alpha(now) {
    const a = (now - this.t) / this.interval;
    return a < 0 ? 0 : a > 1 ? 1 : a;
  }

  renderX(now) {
    const a = this.alpha(now);
    return this.px + (this.x - this.px) * a;
  }

  renderY(now) {
    const a = this.alpha(now);
    return this.py + (this.y - this.py) * a;
  }
}
ClientEntity.interval = 100;
ClientWorld.loInterval = 400;

export function decodeEvents(bytes, world, posQuant) {
  const r = new Reader(bytes);
  r.u8();
  const chunkId = r.varint();
  const cx = chunkId % world.chunksX;
  const cy = (chunkId - cx) / world.chunksX;
  const ox = cx * world.chunkSize;
  const oy = cy * world.chunkSize;
  const cursors = [];
  const n = r.varint();
  for (let i = 0; i < n; i++) {
    const pid = r.varint();
    const x = ox + r.u16() / posQuant;
    const y = oy + r.u16() / posQuant;
    const rgb = r.u24();
    const name = r.str(48);
    cursors.push({ pid, x, y, rgb, name });
  }
  const events = [];
  const m = r.varint();
  for (let i = 0; i < m; i++) {
    const kind = r.u8();
    const pid = r.varint();
    const x = ox + r.u16() / posQuant;
    const y = oy + r.u16() / posQuant;
    const ev = { kind, pid, x, y };
    if (kind === EV_CHAT) {
      ev.name = r.str(48);
      ev.text = r.str(600);
    } else if (kind === EV_ACTION) {
      ev.action = r.u8();
      ev.rgb = r.u24();
    }
    events.push(ev);
  }
  return { chunkId, cursors, events };
}

// World overview: cols x rows cells, each covering bw x bh chunks.
// Per cell: u8 population (log: pop = 2^(q/20) - 1), u24 dominant colour,
// u8 mean nutrient.
export function decodeSummary(bytes) {
  const r = new Reader(bytes);
  r.u8();
  const cols = r.varint();
  const rows = r.varint();
  const bw = r.varint();
  const bh = r.varint();
  const n = cols * rows;
  const pop = new Float32Array(n);
  const rgb = new Uint32Array(n);
  const nutrient = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    pop[i] = Math.pow(2, r.u8() / 20) - 1;
    rgb[i] = r.u24();
    nutrient[i] = r.u8();
  }
  return { cols, rows, bw, bh, pop, rgb, nutrient };
}

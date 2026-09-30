// The part of the world one shard simulates. Knows nothing about sockets:
// the shard node feeds it inbound migrations/ghosts/actions and ships out
// what it returns. This keeps the simulation testable headless.
//
// Cross-shard rules (same idea as SpatialOS / Screeps border handling):
//  * every entity has exactly one owner shard: the one owning its chunk;
//  * entities within `ghostMargin` of a border are copied read-only to the
//    neighbouring shard each tick ("ghosts") so collisions and sensing work
//    across the seam with one tick of latency;
//  * an entity whose position leaves the shard's chunks is serialised and
//    migrated to the new owner, keeping its id;
//  * a shard only mutates its own entities. Effects on a ghost (e.g. being
//    eaten) are not allowed; the game module must respect this.

import { Writer, Reader } from '../shared/codec.js';
import { I_MIGRATE, I_GHOST } from '../shared/protocol.js';

export class Entity {
  constructor(id) {
    this.id = id;
    this.kind = 0;
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.r = 1;
    this.rgb = 0xffffff;
    this.owner = 0; // player id whose lineage this belongs to (0 = wild)
    this.energy = 0;
    this.age = 0;
    this.level = 0; // 0..255 shown to clients (e.g. energy fraction)
    this.dead = false;
    this.ghost = false;
    this.chunk = -1;
    this.data = null; // game-specific payload (genome, brain state, ...)
  }
}

export class Stream {
  constructor(tier) {
    this.tier = tier;
    this.subscribers = new Set();
    this.frameNo = 0;
    this.forceKey = true;
    this.lastSent = new Map();
  }
}

export class Chunk {
  constructor(id, cx, cy, fieldSize) {
    this.id = id;
    this.cx = cx;
    this.cy = cy;
    this.entities = [];
    this.field = new Float32Array(fieldSize);
    this.fieldNext = new Float32Array(fieldSize);
    // Networking state lives here so it moves with the chunk if ownership
    // ever changes: which gateways watch it and what they were last told.
    // One stream per quality tier (0 = 10 Hz, 1 = 2.5 Hz); `subscribers` is
    // the union, used for fields and events.
    this.streams = [new Stream(0), new Stream(1)];
    this.subscribers = new Set();
    this.cursors = new Map(); // playerId -> { x, y, t }
    this.events = [];
  }
}

class HashCell {
  constructor() {
    this.gen = -1;
    this.list = [];
  }
}

// Small deterministic PRNG (mulberry32) so tests and tuning runs repeat.
export function makeRng(seed) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.gauss = () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return rng;
}

export class Region {
  constructor({ topo, shardId, game, seed = 1, ghostMargin = 48, hashCell = 32 }) {
    this.topo = topo;
    this.world = topo.world;
    this.shardId = shardId;
    this.game = game;
    this.rng = makeRng(seed * 7919 + shardId * 104729 + 1);
    this.ghostMargin = ghostMargin;
    this.hashCell = hashCell;
    this.tick = 0;
    this.time = 0;
    this.nextSerial = 1;
    this.players = new Map(); // playerId -> { name, rgb }

    const { fieldRes: G, channels: C, chunkSize } = this.world;
    this.G = G;
    this.C = C;
    this.fieldCell = chunkSize / G;
    this.chunks = new Map();
    for (const id of topo.chunksOf(shardId)) {
      const [cx, cy] = topo.chunkXY(id);
      this.chunks.set(id, new Chunk(id, cx, cy, G * G * C));
    }
    this.neighbours = topo.neighbourShards(shardId);

    // Border chunks: owned chunks adjacent to a chunk owned by someone else,
    // grouped by that someone, so ghost messages are built per neighbour.
    this.borderChunksFor = new Map();
    for (const n of this.neighbours) this.borderChunksFor.set(n, []);
    for (const chunk of this.chunks.values()) {
      const seen = new Set();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = chunk.cx + dx;
          const ny = chunk.cy + dy;
          if (!topo.inBounds(nx, ny)) continue;
          const o = topo.ownerOf(topo.chunkId(nx, ny));
          if (o !== shardId && !seen.has(o)) {
            seen.add(o);
            this.borderChunksFor.get(o).push(chunk);
          }
        }
      }
    }

    this.ghostsFrom = new Map(); // shardId -> Entity[]
    this.ghostEdges = new Map(); // foreign chunkId -> Float32Array(4*G*C)
    this.hash = new Map();
    this.hashGen = 0;
    this.local = []; // flat list of live local entities, rebuilt each tick
    this.maxEntitiesPerChunk = 400;
    this.fieldEvery = 2;
  }

  // ---------------------------------------------------------------- entities

  newId() {
    // Globally unique without coordination: interleave shard id.
    return this.nextSerial++ * this.topo.shardCount + this.shardId;
  }

  // Creates an entity. If the position is not in this shard's chunks it is
  // queued for migration on the next rebucket (so spawning at a border works).
  spawn(props) {
    const e = new Entity(this.newId());
    Object.assign(e, props);
    this.clampToWorld(e);
    this.pendingSpawns.push(e);
    return e;
  }

  get pendingSpawns() {
    if (!this._pending) this._pending = [];
    return this._pending;
  }

  kill(e) {
    e.dead = true;
  }

  clampToWorld(e) {
    const w = this.topo.width;
    const h = this.topo.height;
    const r = e.r;
    if (e.x < r) {
      e.x = r;
      if (e.vx < 0) e.vx = -e.vx * 0.5;
    } else if (e.x > w - r) {
      e.x = w - r;
      if (e.vx > 0) e.vx = -e.vx * 0.5;
    }
    if (e.y < r) {
      e.y = r;
      if (e.vy < 0) e.vy = -e.vy * 0.5;
    } else if (e.y > h - r) {
      e.y = h - r;
      if (e.vy > 0) e.vy = -e.vy * 0.5;
    }
  }

  ownsPoint(x, y) {
    return this.chunks.has(this.topo.chunkAt(x, y));
  }

  entityCount() {
    let n = 0;
    for (const c of this.chunks.values()) n += c.entities.length;
    return n;
  }

  // ------------------------------------------------------------ spatial hash

  hashKey(gx, gy) {
    return gy * 65536 + gx;
  }

  hashInsert(e) {
    const s = this.hashCell;
    const key = this.hashKey(Math.floor(e.x / s), Math.floor(e.y / s));
    let cell = this.hash.get(key);
    if (!cell) {
      cell = new HashCell();
      this.hash.set(key, cell);
    }
    if (cell.gen !== this.hashGen) {
      cell.gen = this.hashGen;
      cell.list.length = 0;
    }
    cell.list.push(e);
  }

  rebuildHash() {
    this.hashGen++;
    if (this.hash.size > 200000) this.hash.clear();
    const local = this.local;
    local.length = 0;
    for (const c of this.chunks.values()) {
      for (const e of c.entities) {
        local.push(e);
        this.hashInsert(e);
      }
    }
    for (const list of this.ghostsFrom.values()) for (const g of list) this.hashInsert(g);
  }

  // Calls fn(entity) for every local or ghost entity whose hash cell overlaps
  // the square of half-size `radius` around (x, y). Distance test is the caller's.
  near(x, y, radius, fn) {
    const s = this.hashCell;
    const gx0 = Math.floor((x - radius) / s);
    const gy0 = Math.floor((y - radius) / s);
    const gx1 = Math.floor((x + radius) / s);
    const gy1 = Math.floor((y + radius) / s);
    const gen = this.hashGen;
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const cell = this.hash.get(this.hashKey(gx, gy));
        if (!cell || cell.gen !== gen) continue;
        const list = cell.list;
        for (let i = 0; i < list.length; i++) fn(list[i]);
      }
    }
  }

  // Nearest local-or-ghost entity of `kind` within `range` of (x, y), other
  // than `exclude`. Allocation-free (no callback), for hot sensing loops.
  nearest(x, y, range, exclude, kind) {
    const s = this.hashCell;
    const gx0 = Math.floor((x - range) / s);
    const gy0 = Math.floor((y - range) / s);
    const gx1 = Math.floor((x + range) / s);
    const gy1 = Math.floor((y + range) / s);
    const gen = this.hashGen;
    let best = range * range;
    let found = null;
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const cell = this.hash.get(gy * 65536 + gx);
        if (!cell || cell.gen !== gen) continue;
        const list = cell.list;
        for (let i = 0; i < list.length; i++) {
          const o = list[i];
          if (o === exclude || o.kind !== kind) continue;
          const dx = o.x - x;
          const dy = o.y - y;
          const d2 = dx * dx + dy * dy;
          if (d2 < best) {
            best = d2;
            found = o;
          }
        }
      }
    }
    return found;
  }

  // ------------------------------------------------------------------ field

  // Value of channel ch at global field cell (gx, gy). Reads owned chunks
  // directly, foreign chunks through the ghost edge rows, and reflects at
  // the world boundary.
  fieldAt(gx, gy, ch) {
    const G = this.G;
    const maxX = this.world.chunksX * G - 1;
    const maxY = this.world.chunksY * G - 1;
    if (gx < 0) gx = 0;
    else if (gx > maxX) gx = maxX;
    if (gy < 0) gy = 0;
    else if (gy > maxY) gy = maxY;
    const cx = Math.floor(gx / G);
    const cy = Math.floor(gy / G);
    const lx = gx - cx * G;
    const ly = gy - cy * G;
    const id = cy * this.world.chunksX + cx;
    const chunk = this.chunks.get(id);
    if (chunk) return chunk.field[(ly * G + lx) * this.C + ch];
    const edges = this.ghostEdges.get(id);
    if (!edges) return 0;
    // Nearest edge row/column of the foreign chunk.
    const dTop = ly;
    const dBottom = G - 1 - ly;
    const dLeft = lx;
    const dRight = G - 1 - lx;
    const m = Math.min(dTop, dBottom, dLeft, dRight);
    let side;
    let i;
    if (m === dTop) {
      side = 0;
      i = lx;
    } else if (m === dBottom) {
      side = 1;
      i = lx;
    } else if (m === dLeft) {
      side = 2;
      i = ly;
    } else {
      side = 3;
      i = ly;
    }
    return edges[(side * G + i) * this.C + ch];
  }

  fieldCellOf(x, y) {
    return [Math.floor(x / this.fieldCell), Math.floor(y / this.fieldCell)];
  }

  sampleField(x, y, ch) {
    const h = this.fieldCell;
    return this.fieldAt(Math.floor(x / h), Math.floor(y / h), ch);
  }

  // Central-difference gradient in field units per world unit.
  fieldGradient(x, y, ch) {
    const h = this.fieldCell;
    const gx = Math.floor(x / h);
    const gy = Math.floor(y / h);
    return [
      (this.fieldAt(gx + 1, gy, ch) - this.fieldAt(gx - 1, gy, ch)) / (2 * h),
      (this.fieldAt(gx, gy + 1, ch) - this.fieldAt(gx, gy - 1, ch)) / (2 * h),
    ];
  }

  // Adds `amount` to the owned field cell containing (x, y); returns the
  // amount actually applied (negative amounts cannot drive a cell below 0).
  fieldAdd(x, y, ch, amount) {
    const id = this.topo.chunkAt(x, y);
    const chunk = this.chunks.get(id);
    if (!chunk) return 0;
    const G = this.G;
    const h = this.fieldCell;
    let lx = Math.floor(x / h) - chunk.cx * G;
    let ly = Math.floor(y / h) - chunk.cy * G;
    if (lx < 0) lx = 0;
    else if (lx >= G) lx = G - 1;
    if (ly < 0) ly = 0;
    else if (ly >= G) ly = G - 1;
    const idx = (ly * G + lx) * this.C + ch;
    const before = chunk.field[idx];
    let after = before + amount;
    if (after < 0) after = 0;
    chunk.field[idx] = after;
    return after - before;
  }

  // Adds amount spread over a disc of radius rad (owned cells only).
  fieldSplash(x, y, rad, ch, amount) {
    const h = this.fieldCell;
    const cells = [];
    const g0x = Math.floor((x - rad) / h);
    const g1x = Math.floor((x + rad) / h);
    const g0y = Math.floor((y - rad) / h);
    const g1y = Math.floor((y + rad) / h);
    for (let gy = g0y; gy <= g1y; gy++) {
      for (let gx = g0x; gx <= g1x; gx++) {
        const cx = (gx + 0.5) * h;
        const cy = (gy + 0.5) * h;
        const d2 = (cx - x) ** 2 + (cy - y) ** 2;
        if (d2 <= rad * rad) cells.push([cx, cy]);
      }
    }
    if (cells.length === 0) cells.push([x, y]);
    const per = amount / cells.length;
    for (const [cx, cy] of cells) this.fieldAdd(cx, cy, ch, per);
  }

  // Explicit diffusion + decay on a padded copy of each chunk: the one-cell
  // halo comes from the neighbouring chunk (owned) or its ghost edge row
  // (foreign), or mirrors the chunk itself at the world wall.
  stepField(dt) {
    const { G, C } = this;
    const P = G + 2;
    const pad = this._pad || (this._pad = new Float32Array(P * P));
    const h2 = this.fieldCell * this.fieldCell;
    const diff = this.game.fieldDiffusion;
    const decay = this.game.fieldDecay;
    for (const chunk of this.chunks.values()) {
      const f = chunk.field;
      const out = chunk.fieldNext;
      const { cx, cy } = chunk;
      // Neighbour sources: [array, stride-mode] resolved once per chunk.
      const west = this.haloSource(cx - 1, cy, 3);
      const east = this.haloSource(cx + 1, cy, 2);
      const north = this.haloSource(cx, cy - 1, 1);
      const south = this.haloSource(cx, cy + 1, 0);
      for (let ch = 0; ch < C; ch++) {
        for (let y = 0; y < G; y++) {
          const row = (y + 1) * P + 1;
          for (let x = 0; x < G; x++) pad[row + x] = f[(y * G + x) * C + ch];
        }
        for (let i = 0; i < G; i++) {
          pad[(i + 1) * P] = this.haloValue(west, G - 1, i, i, ch, f, 0, i);
          pad[(i + 1) * P + G + 1] = this.haloValue(east, 0, i, i, ch, f, G - 1, i);
          pad[i + 1] = this.haloValue(north, i, G - 1, i, ch, f, i, 0);
          pad[(G + 1) * P + i + 1] = this.haloValue(south, i, 0, i, ch, f, i, G - 1);
        }
        // A game may use fewer channels than the world has: extra ones stay inert.
        const k = (dt * (diff[ch] || 0)) / h2;
        const d = 1 - dt * (decay[ch] || 0);
        for (let y = 0; y < G; y++) {
          const row = (y + 1) * P + 1;
          for (let x = 0; x < G; x++) {
            const j = row + x;
            const v = pad[j];
            let nv = v * d + k * (pad[j - 1] + pad[j + 1] + pad[j - P] + pad[j + P] - 4 * v);
            if (nv < 0) nv = 0;
            out[(y * G + x) * C + ch] = nv;
          }
        }
      }
    }
    for (const chunk of this.chunks.values()) {
      const t = chunk.field;
      chunk.field = chunk.fieldNext;
      chunk.fieldNext = t;
    }
  }

  // side: which ghost edge of a foreign chunk faces us (0 top,1 bottom,2 left,3 right)
  haloSource(cx, cy, side) {
    if (!this.topo.inBounds(cx, cy)) return null;
    const id = this.topo.chunkId(cx, cy);
    const own = this.chunks.get(id);
    if (own) return { field: own.field, edges: null, side };
    const edges = this.ghostEdges.get(id);
    return edges ? { field: null, edges, side } : null;
  }

  // Value at local cell (lx, ly) of the neighbour described by src (i indexes
  // along the shared edge); falls back to our own cell (mx, my) = reflection.
  haloValue(src, lx, ly, i, ch, self, mx, my) {
    const { G, C } = this;
    if (!src) return self[(my * G + mx) * C + ch];
    if (src.field) return src.field[(ly * G + lx) * C + ch];
    return src.edges[(src.side * G + i) * C + ch];
  }

  // ------------------------------------------------------------------- tick

  // Advances one fixed step. Returns Map<shardId, Entity[]> of emigrants.
  step(dt) {
    this.tick++;
    this.time += dt;
    this.flushSpawns();
    this.rebuildHash();
    this.game.step(this, dt);
    // Chemistry is slow compared with motion: step it every `fieldEvery`
    // ticks with a proportionally larger dt (still well inside the explicit
    // scheme's stability limit D*dt/h^2 <= 1/4 for the demo's constants).
    if (this.tick % this.fieldEvery === 0) {
      const fdt = dt * this.fieldEvery;
      this.stepField(fdt);
      if (this.game.react) for (const chunk of this.chunks.values()) this.game.react(this, chunk, fdt);
    }
    this.flushSpawns();
    return this.rebucket();
  }

  flushSpawns() {
    if (!this._pending || this._pending.length === 0) return;
    const list = this._pending;
    this._pending = [];
    for (const e of list) this.placeNew(e);
  }

  placeNew(e) {
    const id = this.topo.chunkAt(e.x, e.y);
    const chunk = this.chunks.get(id);
    if (chunk) {
      if (chunk.entities.length >= this.maxEntitiesPerChunk) return;
      e.chunk = id;
      chunk.entities.push(e);
    } else {
      e.chunk = -1;
      (this._strays || (this._strays = [])).push(e);
    }
  }

  rebucket() {
    const out = new Map();
    const emigrate = (e, owner) => {
      let list = out.get(owner);
      if (!list) out.set(owner, (list = []));
      list.push(e);
    };
    if (this._strays) {
      for (const e of this._strays) emigrate(e, this.topo.ownerAt(e.x, e.y));
      this._strays = null;
    }
    for (const chunk of this.chunks.values()) {
      const list = chunk.entities;
      let w = 0;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e.dead) continue;
        this.clampToWorld(e);
        const id = this.topo.chunkAt(e.x, e.y);
        if (id === chunk.id) {
          list[w++] = e;
          continue;
        }
        const dest = this.chunks.get(id);
        if (dest) {
          e.chunk = id;
          dest.entities.push(e);
        } else {
          emigrate(e, this.topo.ownerOf(id));
        }
      }
      list.length = w;
    }
    return out;
  }

  // Accepts entities migrated in from another shard.
  adopt(entities) {
    for (const e of entities) {
      const id = this.topo.chunkAt(e.x, e.y);
      const chunk = this.chunks.get(id);
      if (!chunk) {
        // Topology disagreement or an entity that moved on already: keep it
        // and let rebucket forward it to the right owner.
        (this._strays || (this._strays = [])).push(e);
        continue;
      }
      e.chunk = id;
      chunk.entities.push(e);
    }
  }

  // ---------------------------------------------------------- serialisation

  writeEntity(w, e) {
    w.varint(e.id).u8(e.kind).f32(e.x).f32(e.y).f32(e.vx).f32(e.vy).f32(e.r);
    w.u24(e.rgb).varint(e.owner).f32(e.energy).f32(e.age);
    this.game.encodeData(e, w);
  }

  readEntity(r) {
    const e = new Entity(r.varint());
    e.kind = r.u8();
    e.x = r.f32();
    e.y = r.f32();
    e.vx = r.f32();
    e.vy = r.f32();
    e.r = r.f32();
    e.rgb = r.u24();
    e.owner = r.varint();
    e.energy = r.f32();
    e.age = r.f32();
    this.game.decodeData(e, r);
    return e;
  }

  // `epoch` + `seq` identify the batch so the receiver can acknowledge it
  // and ignore a re-sent copy (see shard-node migration acks).
  encodeMigration(entities, seq = 0, epoch = 0) {
    const w = new Writer(256 + entities.length * 128);
    w.u8(I_MIGRATE).varint(this.shardId).u32(epoch).varint(seq).varint(entities.length);
    for (const e of entities) this.writeEntity(w, e);
    return w.finish();
  }

  decodeMigration(bytes) {
    const r = new Reader(bytes);
    r.u8();
    const from = r.varint();
    const epoch = r.u32();
    const seq = r.varint();
    const n = r.varint();
    const list = [];
    for (let i = 0; i < n; i++) list.push(this.readEntity(r));
    return { from, epoch, seq, entities: list };
  }

  // ------------------------------------------------------------ persistence

  // Whole-shard snapshot: clock, id counter, every owned chunk's chemical
  // field and entities (with game data). Restored only into a shard with the
  // same id, shard count and world geometry.
  serialize() {
    const w = new Writer(1 << 20);
    const { chunksX, chunksY, chunkSize, fieldRes, channels } = this.world;
    w.str('evo-shard-v1').varint(this.shardId).varint(this.topo.shardCount);
    w.varint(chunksX).varint(chunksY).varint(chunkSize).varint(fieldRes).varint(channels);
    w.varint(this.tick).f32(this.time).varint(this.nextSerial);
    w.varint(this.chunks.size);
    for (const chunk of this.chunks.values()) {
      w.varint(chunk.id);
      for (let i = 0; i < chunk.field.length; i++) w.f32(chunk.field[i]);
      w.varint(chunk.entities.length);
      for (const e of chunk.entities) this.writeEntity(w, e);
    }
    return w.finish();
  }

  // Returns false (and changes nothing) if the snapshot does not fit.
  restore(bytes) {
    const r = new Reader(bytes);
    if (r.str() !== 'evo-shard-v1') return false;
    const { chunksX, chunksY, chunkSize, fieldRes, channels } = this.world;
    const header = [r.varint(), r.varint(), r.varint(), r.varint(), r.varint(), r.varint(), r.varint()];
    const want = [this.shardId, this.topo.shardCount, chunksX, chunksY, chunkSize, fieldRes, channels];
    if (header.some((v, i) => v !== want[i])) return false;
    const tick = r.varint();
    const time = r.f32();
    const nextSerial = r.varint();
    const n = r.varint();
    const loaded = [];
    for (let k = 0; k < n; k++) {
      const id = r.varint();
      const field = new Float32Array(this.G * this.G * this.C);
      for (let i = 0; i < field.length; i++) field[i] = r.f32();
      const m = r.varint();
      const ents = [];
      for (let i = 0; i < m; i++) ents.push(this.readEntity(r));
      loaded.push({ id, field, ents });
    }
    for (const c of this.chunks.values()) c.entities = [];
    for (const { id, field, ents } of loaded) {
      const chunk = this.chunks.get(id);
      if (!chunk) continue;
      chunk.field.set(field);
      for (const e of ents) e.chunk = id;
      chunk.entities = ents;
    }
    this.tick = tick;
    this.time = time;
    // After a crash the snapshot may be up to SNAPSHOT_EVERY old, and ids
    // issued since then may still be alive on other shards: skip ahead so
    // they are never handed out twice.
    this.nextSerial = nextSerial + 1000000;
    return true;
  }

  // Per neighbour: entities near the shared seam plus the edge rows of the
  // chemical field of every border chunk.
  encodeGhosts(neighbour) {
    const border = this.borderChunksFor.get(neighbour) || [];
    const G = this.G;
    const C = this.C;
    const S = this.world.chunkSize;
    const m = this.ghostMargin;
    const w = new Writer(4096);
    w.u8(I_GHOST).varint(this.shardId).varint(this.tick).varint(border.length);
    const edge = new Float32Array(4 * G * C);
    const ents = [];
    for (const chunk of border) {
      const f = chunk.field;
      for (let i = 0; i < G; i++) {
        for (let ch = 0; ch < C; ch++) {
          edge[(0 * G + i) * C + ch] = f[(0 * G + i) * C + ch];
          edge[(1 * G + i) * C + ch] = f[((G - 1) * G + i) * C + ch];
          edge[(2 * G + i) * C + ch] = f[(i * G + 0) * C + ch];
          edge[(3 * G + i) * C + ch] = f[(i * G + G - 1) * C + ch];
        }
      }
      w.varint(chunk.id);
      for (let i = 0; i < edge.length; i++) w.f32(edge[i]);
      const ox = chunk.cx * S;
      const oy = chunk.cy * S;
      for (const e of chunk.entities) {
        const lx = e.x - ox;
        const ly = e.y - oy;
        const nearL = lx < m;
        const nearR = lx > S - m;
        const nearT = ly < m;
        const nearB = ly > S - m;
        if (!(nearL || nearR || nearT || nearB)) continue;
        // Is any chunk this entity is close to owned by `neighbour`?
        let hit = false;
        for (let dy = nearT ? -1 : 0; dy <= (nearB ? 1 : 0) && !hit; dy++) {
          for (let dx = nearL ? -1 : 0; dx <= (nearR ? 1 : 0); dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = chunk.cx + dx;
            const ny = chunk.cy + dy;
            if (!this.topo.inBounds(nx, ny)) continue;
            if (this.topo.ownerOf(this.topo.chunkId(nx, ny)) === neighbour) {
              hit = true;
              break;
            }
          }
        }
        if (hit) ents.push(e);
      }
    }
    w.varint(ents.length);
    for (const e of ents) {
      w.varint(e.id).u8(e.kind).f32(e.x).f32(e.y).f32(e.vx).f32(e.vy).f32(e.r);
      w.u24(e.rgb).varint(e.owner).f32(e.energy);
    }
    return w.finish();
  }

  applyGhosts(bytes) {
    const r = new Reader(bytes);
    r.u8();
    const from = r.varint();
    r.varint(); // sender tick (informational)
    const nChunks = r.varint();
    const G = this.G;
    const C = this.C;
    for (let i = 0; i < nChunks; i++) {
      const id = r.varint();
      let edges = this.ghostEdges.get(id);
      if (!edges) this.ghostEdges.set(id, (edges = new Float32Array(4 * G * C)));
      for (let k = 0; k < edges.length; k++) edges[k] = r.f32();
    }
    const n = r.varint();
    const list = [];
    for (let i = 0; i < n; i++) {
      const e = new Entity(r.varint());
      e.kind = r.u8();
      e.x = r.f32();
      e.y = r.f32();
      e.vx = r.f32();
      e.vy = r.f32();
      e.r = r.f32();
      e.rgb = r.u24();
      e.owner = r.varint();
      e.energy = r.f32();
      e.ghost = true;
      list.push(e);
    }
    this.ghostsFrom.set(from, list);
  }

  // A neighbour went away: its ghosts and field edges are stale, drop them
  // rather than colliding with / diffusing against a frozen copy.
  dropPeer(shard) {
    this.ghostsFrom.delete(shard);
    for (const id of [...this.ghostEdges.keys()]) if (this.topo.ownerOf(id) === shard) this.ghostEdges.delete(id);
  }

  // Low-detail per-chunk summary for the world overview.
  summarise() {
    const out = [];
    const G = this.G;
    const C = this.C;
    for (const chunk of this.chunks.values()) {
      const counts = new Map();
      let best = 0;
      let bestRgb = 0;
      let pop = 0;
      for (const e of chunk.entities) {
        if (e.kind !== 1) continue;
        pop++;
        const c = (counts.get(e.rgb) || 0) + 1;
        counts.set(e.rgb, c);
        if (c > best) {
          best = c;
          bestRgb = e.rgb;
        }
      }
      let n = 0;
      for (let i = 0; i < G * G; i++) n += chunk.field[i * C];
      out.push({ id: chunk.id, pop, rgb: bestRgb, nutrient: n / (G * G) });
    }
    return out;
  }

  // Living organisms per owner (lineage), for the leaderboard.
  lineageCounts() {
    const counts = new Map();
    for (const chunk of this.chunks.values()) {
      for (const e of chunk.entities) {
        if (e.kind !== 1 || e.owner === 0) continue;
        counts.set(e.owner, (counts.get(e.owner) || 0) + 1);
      }
    }
    return counts;
  }
}

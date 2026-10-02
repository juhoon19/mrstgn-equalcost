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
import { I_MIGRATE, I_GHOST, I_XFER } from '../shared/protocol.js';

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
    for (const id of topo.chunksOf(shardId)) this.chunks.set(id, this.makeChunk(id));
    this.recomputeBorders();

    this.ghostsFrom = new Map(); // shardId -> Entity[]
    this.ghostEdges = new Map(); // foreign chunkId -> Float32Array(4*G*C)
    // Spatial grid (see rebuildHash).
    this.gridAll = [];
    this.gridEnts = [];
    this.gridCell = new Int32Array(0);
    this.gridGx = new Int32Array(0);
    this.gridStart = new Int32Array(1);
    this.gridCursor = new Int32Array(0);
    this.gridX0 = 0;
    this.gridY0 = 0;
    this.gridW = 0;
    this.gridH = 0;
    this.local = []; // flat list of live local entities, rebuilt each tick
    this.maxEntitiesPerChunk = 400;
    this.fieldEvery = 2;
  }

  makeChunk(id) {
    const [cx, cy] = this.topo.chunkXY(id);
    return new Chunk(id, cx, cy, this.G * this.G * this.C);
  }

  // Neighbour shards and, per neighbour, our chunks that touch its chunks
  // (incl. diagonally). Recomputed whenever ownership changes.
  recomputeBorders() {
    const topo = this.topo;
    // Dense id -> owned chunk table for the hot field accessors (a Map lookup
    // per read was a measurable share of every tick). Every change to the
    // chunk set ends here.
    this.chunkById = new Array(topo.chunkCount).fill(null);
    for (const [id, c] of this.chunks) this.chunkById[id] = c;
    this.borderChunksFor = new Map();
    for (const chunk of this.chunks.values()) {
      const seen = new Set();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = chunk.cx + dx;
          const ny = chunk.cy + dy;
          if (!topo.inBounds(nx, ny)) continue;
          const o = topo.ownerOf(topo.chunkId(nx, ny));
          if (o === this.shardId || seen.has(o)) continue;
          seen.add(o);
          let list = this.borderChunksFor.get(o);
          if (!list) this.borderChunksFor.set(o, (list = []));
          list.push(chunk);
        }
      }
    }
    this.neighbours = [...this.borderChunksFor.keys()].sort((a, b) => a - b);
  }

  // Dynamic ownership: hand a chunk (with everything in it) to another
  // shard, or take one over. Callers update topo.owner around these.
  removeChunk(id) {
    const chunk = this.chunks.get(id);
    if (!chunk) return null;
    this.chunks.delete(id);
    this.recomputeBorders();
    return chunk;
  }

  addChunk(chunk) {
    for (const e of chunk.entities) e.chunk = chunk.id;
    this.chunks.set(chunk.id, chunk);
    this.ghostEdges.delete(chunk.id);
    this.recomputeBorders();
  }

  // Runs game.init on just these (new, empty) chunks.
  initChunks(ids) {
    const all = this.chunks;
    this.chunks = new Map(ids.map((id) => [id, all.get(id)]).filter(([, c]) => c));
    try {
      this.game.init(this);
      this.flushSpawns();
    } finally {
      for (const [id, c] of this.chunks) all.set(id, c);
      this.chunks = all;
    }
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

  // ------------------------------------------------------------ spatial grid
  // Rebuilt every tick: a dense grid over the bounding box of all local and
  // ghost entities, filled by counting sort (cellStart[c]..cellStart[c+1] index
  // into gridEnts). Queries are plain array reads - no hash lookups, no
  // allocation - and each cell keeps insertion order, so iteration order (and
  // therefore the simulation) is identical to a per-cell list.

  rebuildHash() {
    const local = this.local;
    local.length = 0;
    const all = this.gridAll;
    all.length = 0;
    for (const c of this.chunks.values()) {
      for (const e of c.entities) {
        local.push(e);
        all.push(e);
      }
    }
    // Skip ghosts standing in our own chunks: right after a chunk handoff the
    // previous owner's last ghost message can still describe entities that
    // now live here.
    for (const list of this.ghostsFrom.values()) {
      for (const g of list) if (!this.chunks.has(this.topo.chunkAt(g.x, g.y))) all.push(g);
    }
    const n = all.length;
    const s = this.hashCell;
    if (this.gridCell.length < n) this.gridCell = new Int32Array(Math.max(1024, n * 2));
    const cellOf = this.gridCell;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const gxs = this.gridGx.length < n ? (this.gridGx = new Int32Array(Math.max(1024, n * 2))) : this.gridGx;
    for (let i = 0; i < n; i++) {
      const e = all[i];
      const gx = Math.floor(e.x / s);
      const gy = Math.floor(e.y / s);
      gxs[i] = gx;
      cellOf[i] = gy;
      if (gx < x0) x0 = gx;
      if (gx > x1) x1 = gx;
      if (gy < y0) y0 = gy;
      if (gy > y1) y1 = gy;
    }
    if (n === 0) {
      x0 = y0 = 0;
      x1 = y1 = -1;
    }
    const W = x1 - x0 + 1;
    const H = y1 - y0 + 1;
    const cells = Math.max(0, W * H);
    if (this.gridStart.length < cells + 1) this.gridStart = new Int32Array(Math.max(1024, (cells + 1) * 2));
    const start = this.gridStart;
    start.fill(0, 0, cells + 1);
    for (let i = 0; i < n; i++) {
      const c = (cellOf[i] - y0) * W + (gxs[i] - x0);
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < cells; c++) start[c + 1] += start[c];
    // Place in insertion order (cursor = running copy of start).
    if (this.gridCursor.length < cells) this.gridCursor = new Int32Array(Math.max(1024, cells * 2));
    const cur = this.gridCursor;
    cur.set(start.subarray(0, cells));
    const ents = this.gridEnts;
    ents.length = n;
    for (let i = 0; i < n; i++) ents[cur[cellOf[i]]++] = all[i];
    this.gridX0 = x0;
    this.gridY0 = y0;
    this.gridW = W;
    this.gridH = H;
  }

  // Calls fn(entity) for every local or ghost entity whose grid cell overlaps
  // the square of half-size `radius` around (x, y). Distance test is the caller's.
  near(x, y, radius, fn) {
    const s = this.hashCell;
    const W = this.gridW;
    const gx0 = Math.max(this.gridX0, Math.floor((x - radius) / s)) - this.gridX0;
    const gy0 = Math.max(this.gridY0, Math.floor((y - radius) / s)) - this.gridY0;
    const gx1 = Math.min(this.gridX0 + W - 1, Math.floor((x + radius) / s)) - this.gridX0;
    const gy1 = Math.min(this.gridY0 + this.gridH - 1, Math.floor((y + radius) / s)) - this.gridY0;
    const start = this.gridStart;
    const ents = this.gridEnts;
    for (let gy = gy0; gy <= gy1; gy++) {
      const row = gy * W;
      for (let gx = gx0; gx <= gx1; gx++) {
        const c = row + gx;
        for (let i = start[c], end = start[c + 1]; i < end; i++) fn(ents[i]);
      }
    }
  }

  // Nearest local-or-ghost entity of `kind` within `range` of (x, y), other
  // than `exclude`. Allocation-free (no callback), for hot sensing loops.
  nearest(x, y, range, exclude, kind) {
    const s = this.hashCell;
    const W = this.gridW;
    const gx0 = Math.max(this.gridX0, Math.floor((x - range) / s)) - this.gridX0;
    const gy0 = Math.max(this.gridY0, Math.floor((y - range) / s)) - this.gridY0;
    const gx1 = Math.min(this.gridX0 + W - 1, Math.floor((x + range) / s)) - this.gridX0;
    const gy1 = Math.min(this.gridY0 + this.gridH - 1, Math.floor((y + range) / s)) - this.gridY0;
    const start = this.gridStart;
    const ents = this.gridEnts;
    let best = range * range;
    let found = null;
    for (let gy = gy0; gy <= gy1; gy++) {
      const row = gy * W;
      for (let gx = gx0; gx <= gx1; gx++) {
        const c = row + gx;
        for (let i = start[c], end = start[c + 1]; i < end; i++) {
          const o = ents[i];
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
    const chunk = this.chunkById[id];
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
    const chunk = id >= 0 ? this.chunkById[id] : null;
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
    let limbo = null;
    const emigrate = (e, owner) => {
      if (owner === this.shardId) {
        // The map says the chunk is ours but it has not arrived yet (chunk
        // handoff in flight): hold the entity until it does.
        (limbo || (limbo = [])).push(e);
        return;
      }
      let list = out.get(owner);
      if (!list) out.set(owner, (list = []));
      list.push(e);
    };
    if (this._strays) {
      const strays = this._strays;
      this._strays = null;
      for (const e of strays) {
        if (e.dead) continue;
        const dest = this.chunks.get(this.topo.chunkAt(e.x, e.y));
        if (dest) {
          e.chunk = dest.id;
          dest.entities.push(e);
        } else emigrate(e, this.topo.ownerAt(e.x, e.y));
      }
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
    if (limbo) this._strays = limbo.length > 50000 ? limbo.slice(-50000) : limbo;
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
  writeChunk(w, chunk) {
    w.varint(chunk.id);
    for (let i = 0; i < chunk.field.length; i++) w.f32(chunk.field[i]);
    w.varint(chunk.entities.length);
    for (const e of chunk.entities) this.writeEntity(w, e);
  }

  readChunk(r) {
    const chunk = this.makeChunk(r.varint());
    for (let i = 0; i < chunk.field.length; i++) chunk.field[i] = r.f32();
    const m = r.varint();
    for (let i = 0; i < m; i++) {
      const e = this.readEntity(r);
      e.chunk = chunk.id;
      chunk.entities.push(e);
    }
    return chunk;
  }

  // Chunk handoff message (see shard-node: acked like migrations).
  encodeChunkTransfer(chunk, seq, epoch) {
    const w = new Writer(4096 + chunk.entities.length * 400);
    w.u8(I_XFER).varint(this.shardId).u32(epoch).varint(seq);
    this.writeChunk(w, chunk);
    return w.finish();
  }

  decodeChunkTransfer(bytes) {
    const r = new Reader(bytes);
    r.u8();
    const from = r.varint();
    const epoch = r.u32();
    const seq = r.varint();
    return { from, epoch, seq, chunk: this.readChunk(r) };
  }

  // Whole-shard snapshot: ownership map (with version), clock, id counter,
  // every owned chunk's chemical field and entities (with game data).
  serialize() {
    const w = new Writer(1 << 20);
    const { chunksX, chunksY, chunkSize, fieldRes, channels } = this.world;
    w.str('evo-shard-v2').varint(this.shardId).varint(this.topo.shardCount);
    w.varint(chunksX).varint(chunksY).varint(chunkSize).varint(fieldRes).varint(channels);
    w.varint(this.topo.version);
    for (let i = 0; i < this.topo.owner.length; i++) w.varint(this.topo.owner[i]);
    w.varint(this.tick).f32(this.time).varint(this.nextSerial);
    w.varint(this.chunks.size);
    for (const chunk of this.chunks.values()) this.writeChunk(w, chunk);
    return w.finish();
  }

  // Parses a snapshot without applying it; null if it does not belong to
  // this shard / world geometry.
  parseSnapshot(bytes) {
    try {
      const r = new Reader(bytes);
      if (r.str() !== 'evo-shard-v2') return null;
      const { chunksX, chunksY, chunkSize, fieldRes, channels } = this.world;
      const header = [r.varint(), r.varint(), r.varint(), r.varint(), r.varint(), r.varint(), r.varint()];
      const want = [this.shardId, this.topo.shardCount, chunksX, chunksY, chunkSize, fieldRes, channels];
      if (header.some((v, i) => v !== want[i])) return null;
      const version = r.varint();
      const owner = [];
      for (let i = 0; i < this.topo.chunkCount; i++) owner.push(r.varint());
      const tick = r.varint();
      const time = r.f32();
      const nextSerial = r.varint();
      const n = r.varint();
      const chunks = new Map();
      for (let k = 0; k < n; k++) {
        const c = this.readChunk(r);
        chunks.set(c.id, c);
      }
      return { version, owner, tick, time, nextSerial, chunks };
    } catch {
      return null;
    }
  }

  // Loads clock/id counter and the snapshot's copy of every chunk in `ids`
  // that we own; returns the ids that had no saved copy.
  applySnapshot(snap, ids) {
    this.tick = snap.tick;
    this.time = snap.time;
    // After a crash the snapshot may be up to SNAPSHOT_EVERY old, and ids
    // issued since then may still be alive on other shards: skip ahead so
    // they are never handed out twice.
    this.nextSerial = snap.nextSerial + 1000000;
    const missing = [];
    for (const id of ids) {
      const saved = snap.chunks.get(id);
      if (saved && this.chunks.has(id)) {
        this.chunks.set(id, saved);
      } else missing.push(id);
    }
    this.recomputeBorders();
    return missing;
  }

  // Convenience: restore every chunk we currently own. false = incompatible.
  restore(bytes) {
    const snap = this.parseSnapshot(bytes);
    if (!snap) return false;
    const missing = this.applySnapshot(snap, [...this.chunks.keys()]);
    for (const id of missing) this.chunks.get(id).entities = [];
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

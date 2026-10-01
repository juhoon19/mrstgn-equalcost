// World geometry and chunk -> shard ownership. Pure functions, shared by
// shards, gateways, bots and the browser, so every process computes the
// same answer from the same numbers without a coordination service.

export const DEFAULT_WORLD = {
  chunksX: 24,
  chunksY: 24,
  chunkSize: 256, // world units per chunk side; must be <= 8191 (see POS_QUANT)
  fieldRes: 16, // chemical-field cells per chunk side
  channels: 3, // chemical channels in the field
};

// Positions inside a chunk are sent as uint16 in units of 1/POS_QUANT.
export const POS_QUANT = 8;

// Split the chunk grid into sx*sy rectangular blocks, sx*sy === shardCount,
// choosing the factorisation whose blocks are closest to square.
export function shardGrid(world, shardCount) {
  let best = [shardCount, 1];
  let bestScore = Infinity;
  for (let sx = 1; sx <= shardCount; sx++) {
    if (shardCount % sx !== 0) continue;
    const sy = shardCount / sx;
    if (sx > world.chunksX || sy > world.chunksY) continue;
    const bw = world.chunksX / sx;
    const bh = world.chunksY / sy;
    const score = Math.abs(Math.log(bw / bh));
    if (score < bestScore) {
      bestScore = score;
      best = [sx, sy];
    }
  }
  return { sx: best[0], sy: best[1] };
}

export class Topology {
  constructor(world, shardCount) {
    this.world = { ...DEFAULT_WORLD, ...world };
    this.shardCount = shardCount;
    const { sx, sy } = shardGrid(this.world, shardCount);
    this.sx = sx;
    this.sy = sy;
    const { chunksX, chunksY } = this.world;
    this.owner = new Int32Array(chunksX * chunksY);
    for (let cy = 0; cy < chunksY; cy++) {
      for (let cx = 0; cx < chunksX; cx++) {
        const bx = Math.floor((cx * sx) / chunksX);
        const by = Math.floor((cy * sy) / chunksY);
        this.owner[cy * chunksX + cx] = by * sx + bx;
      }
    }
    this.version = 0; // bumped by the coordinator on every ownership change
    const used = new Set(this.owner);
    if (used.size !== shardCount) {
      throw new Error(
        `${shardCount} shards cannot be laid out as a grid on ${chunksX}x${chunksY} chunks ` +
          `(some shard would own nothing); pick a shard count that factors into the chunk grid`,
      );
    }
  }

  // Replaces the chunk -> shard map (dynamic load balancing). Geometry and
  // the shard count never change at runtime; only who owns which chunk.
  setOwners(owners, version) {
    if (owners.length !== this.owner.length) throw new Error('owner map size mismatch');
    for (let i = 0; i < owners.length; i++) {
      const o = owners[i];
      if (!Number.isInteger(o) || o < 0 || o >= this.shardCount) throw new Error(`bad owner ${o} for chunk ${i}`);
    }
    this.owner.set(owners);
    this.version = version;
  }

  // The initial (static) layout, used for chunks nobody has claimed.
  defaultOwners() {
    return Array.from(new Topology(this.world, this.shardCount).owner);
  }

  get width() {
    return this.world.chunksX * this.world.chunkSize;
  }

  get height() {
    return this.world.chunksY * this.world.chunkSize;
  }

  get chunkCount() {
    return this.world.chunksX * this.world.chunksY;
  }

  chunkId(cx, cy) {
    return cy * this.world.chunksX + cx;
  }

  chunkXY(id) {
    const cx = id % this.world.chunksX;
    return [cx, (id - cx) / this.world.chunksX];
  }

  inBounds(cx, cy) {
    return cx >= 0 && cy >= 0 && cx < this.world.chunksX && cy < this.world.chunksY;
  }

  // Chunk containing world point (clamped to the world).
  chunkAt(x, y) {
    const s = this.world.chunkSize;
    let cx = Math.floor(x / s);
    let cy = Math.floor(y / s);
    if (cx < 0) cx = 0;
    else if (cx >= this.world.chunksX) cx = this.world.chunksX - 1;
    if (cy < 0) cy = 0;
    else if (cy >= this.world.chunksY) cy = this.world.chunksY - 1;
    return cy * this.world.chunksX + cx;
  }

  ownerOf(chunkId) {
    return this.owner[chunkId];
  }

  ownerAt(x, y) {
    return this.owner[this.chunkAt(x, y)];
  }

  chunksOf(shard) {
    const out = [];
    for (let i = 0; i < this.owner.length; i++) if (this.owner[i] === shard) out.push(i);
    return out;
  }

  // Shards owning at least one chunk that touches (incl. diagonally) a chunk of `shard`.
  neighbourShards(shard) {
    const set = new Set();
    for (const id of this.chunksOf(shard)) {
      const [cx, cy] = this.chunkXY(id);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!this.inBounds(cx + dx, cy + dy)) continue;
          const o = this.owner[this.chunkId(cx + dx, cy + dy)];
          if (o !== shard) set.add(o);
        }
      }
    }
    return [...set].sort((a, b) => a - b);
  }

  // Chunk ids overlapping a world-space rectangle, clamped to the world.
  chunksInRect(x0, y0, x1, y1) {
    const s = this.world.chunkSize;
    const cx0 = Math.max(0, Math.floor(Math.min(x0, x1) / s));
    const cy0 = Math.max(0, Math.floor(Math.min(y0, y1) / s));
    const cx1 = Math.min(this.world.chunksX - 1, Math.floor(Math.max(x0, x1) / s));
    const cy1 = Math.min(this.world.chunksY - 1, Math.floor(Math.max(y0, y1) / s));
    const out = [];
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) out.push(cy * this.world.chunksX + cx);
    }
    return out;
  }

  // Interest management: chunks a client with this viewport receives in full
  // detail. The view is padded by `margin` world units so panning does not
  // show empty chunks; beyond `maxChunks` the client is zoomed out far
  // enough to use the low-detail world summary instead (returns null).
  // Gateways and clients both call this so they agree on the set.
  viewChunks(x0, y0, x1, y1, margin, maxChunks) {
    const ax = Math.min(x0, x1) - margin;
    const ay = Math.min(y0, y1) - margin;
    const bx = Math.max(x0, x1) + margin;
    const by = Math.max(y0, y1) + margin;
    if (this.rectChunkCount(ax, ay, bx, by) > maxChunks) return null;
    return this.chunksInRect(ax, ay, bx, by);
  }

  // Zones: the world split into zones.cols x zones.rows rectangles (on chunk
  // boundaries), each served by its own gateway pool, so a gateway only
  // ingests the part of the world its players look at.
  zoneOfChunk(zones, chunkId) {
    const [cx, cy] = this.chunkXY(chunkId);
    const zx = Math.floor((cx * zones.cols) / this.world.chunksX);
    const zy = Math.floor((cy * zones.rows) / this.world.chunksY);
    return zy * zones.cols + zx;
  }

  zoneAt(zones, x, y) {
    return this.zoneOfChunk(zones, this.chunkAt(x, y));
  }

  // Zone containing (x, y) only if the point is at least `margin` inside it
  // (hysteresis for handovers); otherwise -1.
  zoneAtStable(zones, x, y, margin) {
    const z = this.zoneAt(zones, x, y);
    for (const [dx, dy] of [
      [margin, 0],
      [-margin, 0],
      [0, margin],
      [0, -margin],
    ]) {
      if (this.zoneAt(zones, x + dx, y + dy) !== z) return -1;
    }
    return z;
  }

  // Number of chunks a rectangle would cover (without building the list).
  rectChunkCount(x0, y0, x1, y1) {
    const s = this.world.chunkSize;
    const cx0 = Math.max(0, Math.floor(Math.min(x0, x1) / s));
    const cy0 = Math.max(0, Math.floor(Math.min(y0, y1) / s));
    const cx1 = Math.min(this.world.chunksX - 1, Math.floor(Math.max(x0, x1) / s));
    const cy1 = Math.min(this.world.chunksY - 1, Math.floor(Math.max(y0, y1) / s));
    if (cx1 < cx0 || cy1 < cy0) return 0;
    return (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
  }
}

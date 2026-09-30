import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writer, Reader } from '../src/shared/codec.js';
import { Topology, POS_QUANT } from '../src/shared/topology.js';
import { ClientWorld } from '../src/shared/protocol.js';
import { Region, Chunk, Entity, makeRng } from '../src/server/region.js';
import { encodeChunkFrame, encodeField } from '../src/server/snapshot.js';
import * as soup from '../src/game/soup.js';

test('codec round-trips every type', () => {
  const w = new Writer(4);
  const ints = [0, 1, 127, 128, 300, 16383, 16384, 2 ** 31 - 1, 2 ** 32 + 5, 2 ** 52];
  const sints = [0, -1, 1, -64, 63, -65, 64, -100000, 100000];
  for (const v of ints) w.varint(v);
  for (const v of sints) w.svarint(v);
  w.u8(255).u16(65535).u24(0xabcdef).u32(0xdeadbeef).f32(1.5).str('原始汤 soup');
  const r = new Reader(w.finish());
  for (const v of ints) assert.equal(r.varint(), v);
  for (const v of sints) assert.equal(r.svarint(), v);
  assert.equal(r.u8(), 255);
  assert.equal(r.u16(), 65535);
  assert.equal(r.u24(), 0xabcdef);
  assert.equal(r.u32(), 0xdeadbeef);
  assert.equal(r.f32(), 1.5);
  assert.equal(r.str(), '原始汤 soup');
  assert.equal(r.remaining, 0);
  assert.throws(() => r.u8(), RangeError);
});

test('reader rejects oversized strings and truncated input', () => {
  const w = new Writer().varint(1000);
  assert.throws(() => new Reader(w.finish()).str(10), RangeError);
  assert.throws(() => new Reader(new Uint8Array([0x80, 0x80])).varint(), RangeError);
});

test('topology: every chunk has one owner, blocks are rectangles, neighbours are symmetric', () => {
  for (const [cx, cy, n] of [
    [24, 24, 4],
    [24, 24, 6],
    [10, 7, 3],
    [8, 8, 1],
    [16, 12, 12],
  ]) {
    const t = new Topology({ chunksX: cx, chunksY: cy }, n);
    const counts = new Array(n).fill(0);
    for (let i = 0; i < t.chunkCount; i++) counts[t.ownerOf(i)]++;
    assert.equal(counts.reduce((a, b) => a + b), cx * cy);
    for (let s = 0; s < n; s++) {
      assert.ok(counts[s] > 0, `shard ${s} owns nothing`);
      const ids = t.chunksOf(s).map((id) => t.chunkXY(id));
      const xs = ids.map((p) => p[0]);
      const ys = ids.map((p) => p[1]);
      const area = (Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1);
      assert.equal(area, ids.length, 'shard block is not a rectangle');
      for (const nb of t.neighbourShards(s)) assert.ok(t.neighbourShards(nb).includes(s));
    }
  }
});

test('topology refuses shard counts that would leave a shard empty', () => {
  assert.throws(() => new Topology({ chunksX: 6, chunksY: 6 }, 7), /cannot be laid out/);
  assert.doesNotThrow(() => new Topology({ chunksX: 6, chunksY: 6 }, 6));
});

test('topology: view chunks and LOD cut-off', () => {
  const t = new Topology({ chunksX: 24, chunksY: 24, chunkSize: 256 }, 4);
  assert.deepEqual(t.viewChunks(10, 10, 20, 20, 0, 30), [0]);
  assert.equal(t.viewChunks(0, 0, 256 * 6, 256 * 6, 0, 30), null);
  assert.equal(t.viewChunks(-500, -500, 100, 100, 0, 30).length, 1);
  assert.equal(t.chunkAt(-5, 1e9), t.chunkId(0, 23));
});

// Random walk of entities in one chunk; every encoded frame is applied to a
// ClientWorld, which must match the truth after every frame.
test('snapshot keyframes + deltas reproduce the chunk exactly', () => {
  const S = 256;
  const chunk = new Chunk(1, 1, 0, 16 * 16 * 3); // id 1 = (1, 0) in a 4-wide world
  const world = { chunksX: 4, chunksY: 4, chunkSize: S, fieldRes: 16, channels: 3 };
  const cw = new ClientWorld(world, POS_QUANT);
  const rng = makeRng(7);
  let nextId = 1;
  const spawn = () => {
    const e = new Entity(nextId++);
    e.kind = 1 + Math.floor(rng() * 2);
    e.x = S + rng() * S;
    e.y = rng() * S;
    e.r = 1 + rng() * 10;
    e.rgb = Math.floor(rng() * 0xffffff);
    e.owner = Math.floor(rng() * 3) * 1000;
    e.level = Math.floor(rng() * 256);
    chunk.entities.push(e);
  };
  for (let i = 0; i < 50; i++) spawn();
  let now = 0;
  for (let frame = 0; frame < 400; frame++) {
    for (const e of chunk.entities) {
      e.x = Math.min(2 * S - 0.01, Math.max(S, e.x + (rng() - 0.5) * 6));
      e.y = Math.min(S - 0.01, Math.max(0, e.y + (rng() - 0.5) * 6));
      if (rng() < 0.05) e.r = 1 + rng() * 10;
      if (rng() < 0.1) e.level = Math.floor(rng() * 256);
    }
    chunk.entities = chunk.entities.filter(() => rng() > 0.02);
    const births = Math.floor(rng() * 3);
    for (let i = 0; i < births; i++) spawn();
    const key = frame === 0 || frame % 37 === 0;
    const bytes = encodeChunkFrame(chunk, S, key);
    assert.ok(cw.applyChunk(bytes, (now += 100)));

    assert.equal(cw.entities.size, chunk.entities.length);
    for (const e of chunk.entities) {
      const c = cw.entities.get(e.id);
      assert.ok(c, `missing ${e.id}`);
      assert.ok(Math.abs(c.x - e.x) <= 0.5 / POS_QUANT + 1e-9);
      assert.ok(Math.abs(c.y - e.y) <= 0.5 / POS_QUANT + 1e-9);
      assert.equal(c.r, Math.round(e.r * 4) / 4);
      assert.equal(c.level, e.level & 0xf0);
      assert.equal(c.rgb, e.rgb);
      assert.equal(c.owner, e.owner);
    }
  }
  assert.equal(cw.stats.unknownIds, 0);
  assert.equal(cw.stats.dupAdds, 0);
});

test('client world: an old replayed chain cannot steal an entity from a newer chunk', () => {
  const S = 256;
  const world = { chunksX: 4, chunksY: 1, chunkSize: S, fieldRes: 16, channels: 3 };
  const cw = new ClientWorld(world, POS_QUANT);
  const a = new Chunk(0, 0, 0, 1);
  const b = new Chunk(1, 1, 0, 1);
  const e = new Entity(42);
  e.kind = 1;
  e.x = 250;
  e.y = 10;
  a.entities.push(e);
  // Old frames of chunk A while it still held the entity.
  const oldKey = encodeChunkFrame(a, S, true);
  const oldDelta = encodeChunkFrame(a, S, false);
  // Entity crosses into B; B reports it (newer clock).
  a.entities = [];
  e.x = 260;
  b.entities.push(e);
  const realNow = Date.now;
  Date.now = () => realNow() + 1000;
  const bKey = encodeChunkFrame(b, S, true);
  const aRemove = encodeChunkFrame(a, S, false);
  Date.now = realNow;
  cw.applyChunk(bKey, 1);
  // Gateway replays A's cached chain afterwards (older data).
  cw.applyChunk(oldKey, 2);
  cw.applyChunk(oldDelta, 3);
  cw.applyChunk(aRemove, 4);
  const got = cw.entities.get(42);
  assert.ok(got, 'entity was lost');
  assert.equal(got.chunk, 1);
  assert.ok(Math.abs(got.x - 260) < 0.2);
});

test('field frames are downsampled', () => {
  const chunk = new Chunk(0, 0, 0, 16 * 16 * 3);
  chunk.field.fill(3);
  const f = encodeField(chunk, 16, 3, 8);
  assert.equal(f.length, 1 + 1 + 1 + 8 * 8 * 3);
});

test('sharded simulation: ids stay unique, entities live in the chunk that contains them', () => {
  const topo = new Topology({ chunksX: 6, chunksY: 6 }, 4);
  const regions = [];
  for (let s = 0; s < 4; s++) {
    const r = new Region({ topo, shardId: s, game: soup, seed: 3 });
    soup.init(r);
    regions.push(r);
  }
  let migrated = 0;
  for (let t = 0; t < 400; t++) {
    const out = regions.map((r) => ({
      emig: r.step(1 / 20),
      ghosts: r.neighbours.map((n) => [n, r.encodeGhosts(n)]),
    }));
    out.forEach((o, s) => {
      for (const [n, bytes] of o.ghosts) regions[n].applyGhosts(bytes);
      for (const [to, list] of o.emig) {
        const { entities } = regions[to].decodeMigration(regions[s].encodeMigration(list));
        migrated += entities.length;
        regions[to].adopt(entities);
      }
    });
  }
  assert.ok(migrated > 20, `expected cross-shard traffic, got ${migrated}`);
  const seen = new Set();
  let cells = 0;
  for (const r of regions) {
    for (const c of r.chunks.values()) {
      for (const e of c.entities) {
        assert.ok(!seen.has(e.id), `duplicate id ${e.id}`);
        seen.add(e.id);
        assert.equal(topo.chunkAt(e.x, e.y), c.id);
        assert.ok(Number.isFinite(e.x) && Number.isFinite(e.energy));
        if (e.kind === 1) cells++;
      }
    }
  }
  assert.ok(cells > 100, `population collapsed: ${cells}`);
});

test('shard snapshot restores entities, fields, ids and clock exactly', () => {
  const topo = new Topology({ chunksX: 4, chunksY: 4 }, 2);
  const a = new Region({ topo, shardId: 1, game: soup, seed: 9 });
  soup.init(a);
  for (let t = 0; t < 60; t++) a.step(1 / 20);
  const bytes = a.serialize();
  const b = new Region({ topo, shardId: 1, game: soup, seed: 1 });
  assert.ok(b.restore(bytes));
  assert.equal(b.tick, a.tick);
  // Restore skips ids ahead so ids issued after the snapshot (possibly alive
  // on other shards after a crash) are never reused.
  assert.ok(b.nextSerial >= a.nextSerial + 1000000);
  for (const [id, ca] of a.chunks) {
    const cb = b.chunks.get(id);
    assert.deepEqual([...cb.field], [...ca.field]);
    assert.equal(cb.entities.length, ca.entities.length);
    ca.entities.forEach((e, i) => {
      const f = cb.entities[i];
      assert.equal(f.id, e.id);
      assert.equal(f.owner, e.owner);
      assert.equal(Math.fround(e.x), f.x);
      if (e.data) assert.deepEqual([...f.data.genome], [...e.data.genome]);
    });
  }
  // Wrong shard / geometry is refused without touching the region.
  const other = new Region({ topo, shardId: 0, game: soup, seed: 1 });
  assert.equal(other.restore(bytes), false);
});

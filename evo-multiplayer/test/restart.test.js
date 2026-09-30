// Whole-cluster restart after chunks have moved: the ownership map and every
// chunk's contents must come back exactly (cold boot from snapshot claims),
// and a single restarted shard must rejoin a live cluster with the live map.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startShard } from '../src/server/shard-node.js';
import { loadGame } from '../src/server/game-loader.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(25);
  }
  return false;
}

test('ownership map and chunk contents survive a full restart and a single-shard restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-restart-'));
  const base = 40000 + Math.floor(Math.random() * 15000);
  const topology = { world: { chunksX: 4, chunksY: 4 }, shards: [0, 1, 2, 3].map((i) => `ws://127.0.0.1:${base + i}`) };
  const game = await loadGame('soup');
  const start = (i, extra = {}) =>
    startShard({ shard: i, port: base + i, topology, secret: 's', game, quiet: true, dataDir, balance: false, bootWait: 3000, ...extra });

  let shards = await Promise.all([0, 1, 2, 3].map((i) => start(i)));
  const coord = shards[0];
  // Move a few chunks around.
  for (const [chunk, to] of [
    [1, 1],
    [5, 3],
    [10, 0],
  ]) {
    assert.ok(await until(() => coord.requestMove(chunk, to)));
    assert.ok(await until(() => !coord.coordinator.pending));
    assert.ok(await until(() => shards[to].region.chunks.has(chunk)));
  }
  for (const s of shards) s.pause();
  await sleep(200);
  const owner = Array.from(coord.region.topo.owner);
  const content = new Map();
  for (const s of shards) for (const c of s.region.chunks.values()) content.set(c.id, c.entities.map((e) => e.id).sort((a, b) => a - b).join(','));
  for (const s of shards) s.save();
  for (const s of shards) s.close();
  await sleep(300);

  // Cold boot: start them in reverse order to make sure order doesn't matter.
  shards = await Promise.all([3, 2, 1, 0].map((i) => start(i))).then((a) => a.reverse());
  for (const s of shards) s.pause();
  assert.deepEqual(Array.from(shards[0].region.topo.owner), owner, 'map restored');
  for (const s of shards) {
    assert.deepEqual(Array.from(s.region.topo.owner), owner);
    for (const c of s.region.chunks.values()) {
      assert.equal(owner[c.id], s.region.shardId);
      const ids = c.entities.map((e) => e.id).sort((a, b) => a - b).join(',');
      assert.equal(ids, content.get(c.id), `chunk ${c.id} contents`);
    }
  }
  for (const s of shards) s.resume();

  // One shard crashes and comes back while the others run: it gets the live
  // map from the coordinator and restores its own chunks.
  const v = shards[0].region.topo.version;
  shards[3].close();
  await sleep(300);
  shards[3] = await start(3);
  assert.equal(shards[3].region.topo.version, v);
  assert.deepEqual(Array.from(shards[3].region.topo.owner), owner);
  assert.deepEqual([...shards[3].region.chunks.keys()].sort((a, b) => a - b), owner.map((o, i) => (o === 3 ? i : -1)).filter((i) => i >= 0));

  for (const s of shards) s.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

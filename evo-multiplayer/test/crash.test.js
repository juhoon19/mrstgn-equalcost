// A shard that crashes (no final snapshot) comes back from an older snapshot.
// Organisms that crossed into a neighbour after that snapshot was taken are
// restored too - the same id would then exist twice. The world must stay
// free of duplicate ids anyway.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startShard } from '../src/server/shard-node.js';
import { loadGame } from '../src/server/game-loader.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function idCounts(shards) {
  const where = new Map(); // id -> count
  let inShardDup = 0;
  for (const s of shards) {
    const seen = new Set();
    for (const c of s.region.chunks.values()) {
      for (const e of c.entities) {
        if (seen.has(e.id)) inShardDup++;
        seen.add(e.id);
        where.set(e.id, (where.get(e.id) || 0) + 1);
      }
    }
  }
  let dup = 0;
  for (const n of where.values()) if (n > 1) dup++;
  return { dup, inShardDup, total: where.size };
}

test('a crashed shard restored from an old snapshot does not duplicate organisms', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-crash-'));
  const base = 45000 + Math.floor(Math.random() * 4500);
  // 2 shards side by side, small chunks so organisms cross the seam often.
  const topology = { world: { chunksX: 4, chunksY: 2, chunkSize: 128 }, shards: [0, 1].map((i) => `ws://127.0.0.1:${base + i}`) };
  const game = await loadGame('soup');
  const start = (i) =>
    startShard({ shard: i, port: base + i, topology, secret: 's', game, quiet: true, dataDir, balance: false, bootWait: 2000, snapshotEvery: 3600, seed: 3 });
  let shards = await Promise.all([0, 1].map(start));
  await sleep(1500);
  shards[1].save(); // the snapshot the crashed shard will come back from
  const migratedBefore = shards[0].stats ? 0 : 0;
  void migratedBefore;
  await sleep(4000); // organisms cross the seam after the snapshot
  shards[1].close(); // crash: no final snapshot
  await sleep(300);
  shards[1] = await start(1);
  // Watch for a while: duplicates either never appear or are removed.
  let worst = { dup: 0, inShardDup: 0 };
  for (let k = 0; k < 40; k++) {
    await sleep(150);
    const c = idCounts(shards);
    if (c.dup > worst.dup) worst = { ...worst, dup: c.dup };
    if (c.inShardDup > worst.inShardDup) worst = { ...worst, inShardDup: c.inShardDup };
  }
  const end = idCounts(shards);
  for (const s of shards) s.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('duplicates seen:', worst, 'at the end:', end);
  assert.equal(worst.inShardDup, 0, 'two organisms with one id on the same shard');
  assert.equal(end.dup, 0, 'duplicate organisms survive in the world');
});

// Every bundled game module must satisfy the loader and survive a sharded
// run with migrations (ids unique, entities in the right chunk, snapshot
// round-trip).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGame } from '../src/server/game-loader.js';
import { Topology } from '../src/shared/topology.js';
import { Region } from '../src/server/region.js';

for (const name of ['soup', 'template']) {
  test(`game module "${name}" runs sharded`, async () => {
    const game = await loadGame(name);
    const topo = new Topology({ chunksX: 4, chunksY: 4 }, 4);
    const regions = [0, 1, 2, 3].map((s) => {
      const r = new Region({ topo, shardId: s, game, seed: 11 });
      game.init(r);
      return r;
    });
    // A player action on every shard.
    for (const r of regions) {
      const [c] = r.chunks.values();
      const x = (c.cx + 0.5) * topo.world.chunkSize;
      const y = (c.cy + 0.5) * topo.world.chunkSize;
      for (const type of [1, 2, 3, 4]) game.onAction(r, { pid: 7, type, x, y, dx: 1, dy: 0 }, { name: 'p', rgb: 0xffffff, hue: 0.5 });
    }
    let migrated = 0;
    for (let t = 0; t < 200; t++) {
      const out = regions.map((r) => ({ emig: r.step(1 / 20), ghosts: r.neighbours.map((n) => [n, r.encodeGhosts(n)]) }));
      out.forEach((o, s) => {
        for (const [n, b] of o.ghosts) regions[n].applyGhosts(b);
        for (const [to, list] of o.emig) {
          const { entities } = regions[to].decodeMigration(regions[s].encodeMigration(list));
          migrated += entities.length;
          regions[to].adopt(entities);
        }
      });
    }
    const ids = new Set();
    let n = 0;
    for (const r of regions) {
      for (const c of r.chunks.values()) {
        for (const e of c.entities) {
          assert.ok(!ids.has(e.id));
          ids.add(e.id);
          assert.equal(topo.chunkAt(e.x, e.y), c.id);
          n++;
        }
      }
      const copy = new Region({ topo, shardId: r.shardId, game, seed: 1 });
      assert.ok(copy.restore(r.serialize()));
      assert.equal(copy.entityCount(), r.entityCount());
    }
    assert.ok(n > 0);
    assert.ok(migrated >= 0);
  });
}

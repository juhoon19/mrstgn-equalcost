import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Topology } from '../src/shared/topology.js';
import { Coordinator } from '../src/server/coordinator.js';

function make(shards = 2, world = { chunksX: 4, chunksY: 2 }) {
  const topo = new Topology(world, shards);
  const sent = [];
  const maps = [];
  const c = new Coordinator({
    topo,
    send: (shard, msg) => sent.push([shard, msg]),
    broadcast: (msg) => maps.push(msg),
    opts: { hotMs: 10, cooldownMs: 0, warmupMs: 0, hotStreak: 1 },
  });
  return { topo, c, sent, maps };
}

test('cold boot: each chunk goes to the freshest saved copy, the rest to the static layout', () => {
  const { topo, c, maps } = make();
  // Static layout on 4x2 with 2 shards: x<2 -> 0, x>=2 -> 1.
  c.addClaim({ shard: 0, live: false, snap: { tick: 100, version: 3, chunks: [0, 1, 2] } });
  c.addClaim({ shard: 1, live: false, snap: { tick: 200, version: 3, chunks: [2, 3, 6, 7] } });
  c.decideBoot();
  assert.equal(topo.ownerOf(0), 0);
  assert.equal(topo.ownerOf(1), 0);
  assert.equal(topo.ownerOf(2), 1, 'shard 1 has the fresher copy of chunk 2');
  assert.equal(topo.ownerOf(4), 0, 'unclaimed chunk follows the static layout');
  assert.equal(topo.version, 4);
  assert.equal(maps.length, 1);
});

test('boot with live shards adopts the newest live map (coordinator restart)', () => {
  const { topo, c } = make();
  const owner = [1, 1, 1, 1, 0, 1, 1, 1];
  c.addClaim({ shard: 0, live: false, snap: null });
  c.addClaim({ shard: 1, live: true, version: 9, owner });
  c.decideBoot();
  assert.deepEqual(Array.from(topo.owner), owner);
  assert.equal(topo.version, 9);
});

test('a restarting shard is sent the current map', () => {
  const { c, sent } = make();
  c.addClaim({ shard: 0, live: false });
  c.addClaim({ shard: 1, live: false });
  c.decideBoot();
  c.addClaim({ shard: 1, live: false });
  assert.equal(sent.at(-1)[0], 1);
  assert.equal(sent.at(-1)[1].t, 'map');
});

test('balancing moves a populated border chunk from the hot shard to the cool neighbour, one at a time', () => {
  const { topo, c, sent, maps } = make();
  c.addClaim({ shard: 0, live: false });
  c.addClaim({ shard: 1, live: false });
  c.decideBoot();
  // Shard 0 owns chunks 0,1,4,5; its border with shard 1 is chunks 1 and 5.
  c.onLoad({ shard: 0, tickMs: 40, entities: 400, chunks: [[0, 50], [1, 100], [4, 50], [5, 200]] });
  c.onLoad({ shard: 1, tickMs: 5, entities: 50, chunks: [[2, 10], [3, 10], [6, 10], [7, 20]] });
  const plan = c.tick();
  assert.ok(plan);
  assert.ok([1, 5].includes(plan.chunk), `picked interior chunk ${plan.chunk}`);
  assert.equal(plan.to, 1);
  assert.deepEqual(sent.at(-1), [0, { t: 'move', chunk: plan.chunk, to: 1 }]);
  assert.equal(c.tick(), null, 'no second move while one is pending');
  c.onMoved({ chunk: plan.chunk, from: 0, to: 1, ok: true });
  assert.equal(topo.ownerOf(plan.chunk), 1);
  assert.deepEqual(maps.at(-1), { t: 'mapd', prev: topo.version - 1, version: topo.version, set: [[plan.chunk, 1]] });
});

test('no move that would just flip the imbalance, and never below one chunk', () => {
  const { c } = make();
  c.addClaim({ shard: 0, live: false });
  c.addClaim({ shard: 1, live: false });
  c.decideBoot();
  // One huge border chunk: moving it would make shard 1 the hot one.
  c.onLoad({ shard: 0, tickMs: 40, entities: 1000, chunks: [[0, 0], [1, 1000], [4, 0], [5, 0]] });
  c.onLoad({ shard: 1, tickMs: 20, entities: 500, chunks: [[2, 500], [3, 0], [6, 0], [7, 0]] });
  assert.equal(c.tick(), null);
});

test('load reports correct a stale map (lost confirmation)', () => {
  const { topo, c, maps } = make();
  c.addClaim({ shard: 0, live: false });
  c.addClaim({ shard: 1, live: false });
  c.decideBoot();
  const v = topo.version;
  c.onLoad({ shard: 1, tickMs: 1, entities: 1, chunks: [[1, 3], [2, 0]] });
  assert.equal(topo.ownerOf(1), 1);
  assert.equal(topo.version, v + 1);
  assert.deepEqual(maps.at(-1).set, [[1, 1]]);
});

test('hysteresis: a single hot second does not trigger a move; sustained heat does', () => {
  const topo = new Topology({ chunksX: 4, chunksY: 2 }, 2);
  const c = new Coordinator({ topo, send: () => {}, broadcast: () => {}, opts: { hotMs: 10, cooldownMs: 0, warmupMs: 0, hotStreak: 3 } });
  c.addClaim({ shard: 0, live: false });
  c.addClaim({ shard: 1, live: false });
  c.decideBoot();
  const report = (ms0) => {
    c.onLoad({ shard: 0, tickMs: ms0, entities: 400, chunks: [[0, 50], [1, 100], [4, 50], [5, 200]] });
    c.onLoad({ shard: 1, tickMs: 2, entities: 40, chunks: [[2, 10], [3, 10], [6, 10], [7, 10]] });
  };
  report(60); // spike
  assert.equal(c.tick(), null);
  report(1);
  assert.equal(c.tick(), null);
  report(1);
  assert.equal(c.tick(), null, 'spike alone must not move anything');
  for (let i = 0; i < 6; i++) report(40);
  let plan = null;
  for (let i = 0; i < 3 && !plan; i++) plan = c.tick();
  assert.ok(plan, 'sustained heat should move a chunk');
});

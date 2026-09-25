// Runs the sharded simulation in one process with no sockets: shards
// exchange migrations and ghosts directly. Used to tune the game and to
// measure simulation cost per shard.
//
//   node bench/headless.js --shards 4 --world 16x16 --seconds 300

import { Topology } from '../src/shared/topology.js';
import { Region } from '../src/server/region.js';
import { loadGame } from '../src/server/game-loader.js';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const shards = Number(arg('shards', 4));
const [cw, ch] = arg('world', '16x16').split('x').map(Number);
const seconds = Number(arg('seconds', 120));
const tickHz = 20;
const game = await loadGame(arg('game', 'soup'));
const topo = new Topology({ chunksX: cw, chunksY: ch }, shards);
const regions = [];
for (let s = 0; s < shards; s++) {
  const r = new Region({ topo, shardId: s, game, seed: 42 });
  game.init(r);
  regions.push(r);
}

const dt = 1 / tickHz;
const ticks = seconds * tickHz;
const tickMs = new Array(shards).fill(0);
let migrated = 0;
for (let t = 1; t <= ticks; t++) {
  const outbound = [];
  for (let s = 0; s < shards; s++) {
    const t0 = performance.now();
    const emig = regions[s].step(dt);
    const ghosts = regions[s].neighbours.map((n) => [n, regions[s].encodeGhosts(n)]);
    const mig = [...emig].map(([to, list]) => [to, regions[s].encodeMigration(list)]);
    tickMs[s] += performance.now() - t0;
    outbound.push({ ghosts, mig });
  }
  for (let s = 0; s < shards; s++) {
    for (const [to, bytes] of outbound[s].ghosts) regions[to].applyGhosts(bytes);
    for (const [to, bytes] of outbound[s].mig) {
      const { entities } = regions[to].decodeMigration(bytes);
      migrated += entities.length;
      regions[to].adopt(entities);
    }
  }
  if (t % (tickHz * 10) === 0) {
    let cells = 0;
    let pellets = 0;
    let energy = 0;
    const hues = new Set();
    let nutrient = 0;
    for (const r of regions) {
      for (const c of r.chunks.values()) {
        for (const e of c.entities) {
          if (e.kind === 1) {
            cells++;
            energy += e.energy;
            hues.add(Math.round(e.data.genome[e.data.genome.length - 2] * 20));
          } else pellets++;
        }
        for (let i = 0; i < c.field.length; i += r.C) nutrient += c.field[i];
      }
    }
    const ms = tickMs.map((m) => (m / (tickHz * 10)).toFixed(2));
    tickMs.fill(0);
    console.log(
      `t=${(t / tickHz).toFixed(0)}s cells=${cells} pellets=${pellets} meanE=${(energy / Math.max(1, cells)).toFixed(1)} ` +
        `hueBins=${hues.size} N=${(nutrient / (cw * ch)).toFixed(0)}/chunk migrated=${migrated} ms/tick per shard=[${ms}]`,
    );
  }
}

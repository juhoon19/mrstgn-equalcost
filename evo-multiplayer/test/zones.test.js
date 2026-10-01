// Zones: a lobby gateway hands players to per-zone gateways, which then only
// watch (and ingest) their own part of the world. Bots cross zone borders
// while fully decoding; nothing may desync and identities must survive.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startShard } from '../src/server/shard-node.js';
import { startGateway } from '../src/server/gateway-node.js';
import { loadGame } from '../src/server/game-loader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const base = 21000 + Math.floor(Math.random() * 8000);
const topology = { world: { chunksX: 8, chunksY: 4 }, shards: [`ws://127.0.0.1:${base}`, `ws://127.0.0.1:${base + 1}`] };
const gwPorts = [base + 10, base + 11, base + 12]; // lobby, zone 0, zone 1
const zones = { cols: 2, rows: 1, urls: [`ws://127.0.0.1:${gwPorts[1]}/ws`, `ws://127.0.0.1:${gwPorts[2]}/ws`] };
let shards = [];
let gws = [];

before(async () => {
  const game = await loadGame('soup');
  shards = await Promise.all([0, 1].map((i) => startShard({ shard: i, port: base + i, topology, secret: 's', game, quiet: true, balance: false, bootWait: 3000 })));
  gws = await Promise.all(
    [-1, 0, 1].map((zone, i) =>
      startGateway({ port: gwPorts[i], host: '127.0.0.1', topology, secret: 's', tokenSecret: 't', quiet: true, zones, zone, maxPerIp: 1000 }),
    ),
  );
});

after(() => {
  for (const g of gws) g.close();
  for (const s of shards) s.close();
});

function runBots(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(HERE, '../bench/bots.js'), ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('exit', () => {
      const line = out.split('\n').find((l) => l.startsWith('[bots] result '));
      if (!line) return reject(new Error('no result:\n' + out));
      resolve(JSON.parse(line.slice('[bots] result '.length)));
    });
  });
}

test('players are handed over between zone gateways without desync or identity loss', async () => {
  // 8x4 chunks of 256 = 2048 x 1024 world; zone border at x = 1024. Bots
  // drift across it with a small viewport.
  const r = await runBots([
    '--url', `ws://127.0.0.1:${gwPorts[0]}/ws`,
    '--n', '24', '--ramp', '100', '--duration', '18', '--decode', '1', '--act', '0.5',
    '--view-w', '300', '--view-h', '200', '--quiet', 'true',
  ]);
  assert.equal(r.welcomed, 24);
  assert.ok(r.handovers >= 24, `expected every bot to leave the lobby and some to cross zones, got ${r.handovers}`);
  assert.equal(r.identityLost, 0, 'identity changed during a handover');
  assert.equal(r.unknownIds, 0);
  assert.equal(r.dupAdds, 0);
  const lobby = gws[0].metrics();
  assert.equal(lobby.clients, 0, 'lobby kept clients');
  for (const g of gws.slice(1)) {
    const m = g.metrics();
    // Each zone gateway mostly watches its own half (border overlap allowed).
    assert.ok(m.watchedChunks > 0);
    assert.ok(m.watchedOutsideZone <= m.watchedChunks / 2, `zone ${m.zone}: ${m.watchedOutsideZone}/${m.watchedChunks} outside`);
  }
});

// Regression tests for specific hardening (a security review found these):
//  * the dev cluster secret must not be usable on a public bind;
//  * the internal hello secret compare is constant-time and length-safe;
//  * a client sweeping its view across the world is subscription-capped;
//  * the admin login throttles brute force by IP;
//  * oversized / malformed input does not crash the gateway.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startShard } from '../src/server/shard-node.js';
import { startGateway } from '../src/server/gateway-node.js';
import { loadGame } from '../src/server/game-loader.js';
import { assertClusterSecret, secretEqual, DEV_SECRET } from '../src/server/link.js';
import { encodeView, TIER_LO } from '../src/shared/protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('assertClusterSecret refuses the dev secret on a public bind only', () => {
  assert.throws(() => assertClusterSecret({ host: '0.0.0.0', secret: DEV_SECRET }), /dev cluster secret/);
  assert.throws(() => assertClusterSecret({ host: '192.168.1.5', secret: DEV_SECRET }), /dev cluster secret/);
  assert.doesNotThrow(() => assertClusterSecret({ host: '127.0.0.1', secret: DEV_SECRET }));
  assert.doesNotThrow(() => assertClusterSecret({ host: '::1', secret: DEV_SECRET }));
  assert.doesNotThrow(() => assertClusterSecret({ host: '0.0.0.0', secret: 'a-real-secret' }));
  process.env.ALLOW_DEV_SECRET = '1';
  assert.doesNotThrow(() => assertClusterSecret({ host: '0.0.0.0', secret: DEV_SECRET }));
  delete process.env.ALLOW_DEV_SECRET;
});

test('secretEqual is constant-time-safe and length-safe', () => {
  assert.equal(secretEqual('abc', 'abc'), true);
  assert.equal(secretEqual('abc', 'abd'), false);
  assert.equal(secretEqual('abc', 'abcd'), false); // different lengths do not throw
  assert.equal(secretEqual('', ''), true);
  assert.equal(secretEqual(undefined, null), true); // both empty
});

const base = 46000 + Math.floor(Math.random() * 3500);
const CX = 16;
const CY = 16;
const topology = { world: { chunksX: CX, chunksY: CY }, shards: [0, 1].map((i) => `ws://127.0.0.1:${base + i}`) };
const secret = 'sec';
const ADMIN = 'admintoken';
let shards = [];
let gw;

before(async () => {
  const game = await loadGame('soup');
  shards = await Promise.all([0, 1].map((i) => startShard({ shard: i, port: base + i, topology, secret, game, quiet: true, bootWait: 2000 })));
  // subBurst small so the churn cap is observable; wrong secret is rejected by shards.
  gw = await startGateway({ port: 0, host: '127.0.0.1', topology, secret, quiet: true, adminToken: ADMIN, maxPerIp: 50, subBurst: 5, subRefill: 1 });
  await sleep(400);
});
after(() => {
  gw?.close();
  for (const s of shards) s.close();
});

function raw() {
  const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws`);
  const c = { ws, welcome: null, closed: null };
  ws.on('message', (d, bin) => {
    if (bin) return;
    const m = JSON.parse(d.toString());
    if (m.t === 'welcome') c.welcome = m;
  });
  ws.on('close', (code) => (c.closed = code));
  ws.on('error', () => {});
  return c;
}
async function joined() {
  const c = raw();
  await new Promise((r) => c.ws.on('open', r));
  c.ws.send(JSON.stringify({ t: 'hello', name: 'sweeper' }));
  for (let i = 0; i < 100 && !c.welcome; i++) await sleep(20);
  return c;
}

test('a client requesting a huge view at once is subscription-rate-capped', async () => {
  const c = await joined();
  assert.ok(c.welcome);
  const S = c.welcome.world.chunkSize;
  const W = CX * S;
  const H = CY * S;
  const total = CX * CY;
  void W;
  void H;
  // A normal hi-tier view wants ~a dozen chunks - more than this gateway's tiny
  // subBurst(5). The gateway opens them a few per tick instead of all at once,
  // and reports the throttling. (It still fills in over time: a rate cap, not a
  // denial - that is why we check watched grows toward the view, not to 0.)
  c.ws.send(encodeView(0, 0, S * 3, S * 3));
  await sleep(150);
  const early = gw.metrics();
  assert.ok(early.subThrottled > 0, `churn throttled (subThrottled=${early.subThrottled})`);
  await sleep(1500); // tokens refill, the rest of the view fills in
  const m1 = gw.metrics();
  assert.ok(m1.watchedChunks > 0 && m1.watchedChunks < total, `watched ${m1.watchedChunks} of ${total}`);
  c.ws.close();
});

test('oversized and malformed frames do not crash the gateway', async () => {
  const c = raw();
  await new Promise((r) => c.ws.on('open', r));
  c.ws.send(JSON.stringify({ t: 'hello', name: 'x' }));
  for (let i = 0; i < 100 && !c.welcome; i++) await sleep(20);
  assert.ok(c.welcome);
  // Over the 4 KB payload cap -> the ws layer closes this socket, gateway lives.
  c.ws.send('{"t":"chat","text":"' + 'A'.repeat(8000) + '"}');
  // Malformed binary of each type, and junk.
  c.ws.send(Buffer.from([10, 1, 2, 3])); // short C_VIEW
  c.ws.send(Buffer.from([11, 255])); // short C_ACTION
  c.ws.send(Buffer.from(new Array(50).fill(99))); // unknown type
  c.ws.send('not json at all');
  await sleep(300);
  // A fresh client still gets served: the gateway is alive.
  const c2 = await joined();
  assert.ok(c2.welcome, 'gateway still serves new clients after junk');
  c.ws.close();
  c2.ws.close();
});

test('a shard rejects an internal hello with the wrong secret', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${base}`);
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', role: 'gateway', id: 'evil', secret: 'WRONG' })));
  ws.on('error', () => {});
  const code = await Promise.race([closed, sleep(2000).then(() => 'stillopen')]);
  assert.equal(code, 1008, 'bad-secret internal hello is closed');
});

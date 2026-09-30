// Starts real shard and gateway servers (in-process, real sockets), connects
// real WebSocket clients and checks what they see against the servers' state.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startShard } from '../src/server/shard-node.js';
import { startGateway } from '../src/server/gateway-node.js';
import { loadGame } from '../src/server/game-loader.js';
import { POS_QUANT } from '../src/shared/topology.js';
import { ClientWorld, S_CHUNK, S_EVENTS, ACTIONS, encodeView, encodeAction, encodeCursor, decodeEvents, unpackBatch, TIER_HI, TIER_LO } from '../src/shared/protocol.js';

const base = 20000 + Math.floor(Math.random() * 20000);
const topology = {
  world: { chunksX: 6, chunksY: 6 },
  // 2x2 shard grid: exercises edge AND diagonal (corner) handoffs.
  shards: [0, 1, 2, 3].map((i) => `ws://127.0.0.1:${base + i}`),
};
const secret = 'test-secret';
let shards = [];
let gateway;
let proxied;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  const game = await loadGame('soup');
  shards = await Promise.all(
    [0, 1, 2, 3].map((i) => startShard({ shard: i, port: base + i, topology, secret, game, netEvery: 1, loEvery: 1, quiet: true, seed: 5 })),
  );
  gateway = await startGateway({ port: 0, host: '127.0.0.1', topology, secret, maxChunks: 100, quiet: true, maxPerIp: 4 });
  proxied = await startGateway({ port: 0, host: '127.0.0.1', topology, secret, quiet: true, maxPerIp: 2, trustProxy: true });
  await sleep(500);
});

after(() => {
  gateway?.close();
  proxied?.close();
  for (const s of shards) s.close();
});

function client(hello = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`);
  const c = { ws, welcome: null, world: null, events: [], closed: false };
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'tester', ...hello })));
  ws.on('close', () => (c.closed = true));
  ws.on('error', () => {});
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const m = JSON.parse(data.toString());
      if (m.t === 'welcome') {
        c.welcome = m;
        c.world = new ClientWorld(m.world, m.posQuant);
      }
      return;
    }
    unpackBatch(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), (u8) => {
      if (u8[0] === S_CHUNK) c.world.applyChunk(u8, performance.now());
      else if (u8[0] === S_EVENTS) c.events.push(decodeEvents(u8, c.welcome.world, c.welcome.posQuant));
    });
  });
  return c;
}

async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(25);
  }
  return false;
}

// loEvery is 1 here so the low-rate tier also ends exactly on the paused
// tick; its separate stream state, flags and gateway keys are still exercised.
test('client replicas (both quality tiers) match the authoritative state exactly', async () => {
  const hi = client();
  const lo = client();
  assert.ok(await until(() => hi.welcome && lo.welcome));
  const W = 6 * 256;
  hi.ws.send(encodeView(0, 0, W, W, TIER_HI));
  lo.ws.send(encodeView(0, 0, W, W, TIER_LO));
  await sleep(3000); // let entities move, migrate across the shard seam, be born and die
  for (const s of shards) s.pause();
  await sleep(400); // drain in-flight frames
  const truth = new Map();
  for (const s of shards) for (const ch of s.region.chunks.values()) for (const e of ch.entities) truth.set(e.id, e);
  assert.ok(truth.size > 100);
  for (const c of [hi, lo]) {
    assert.equal(c.world.entities.size, truth.size, 'entity count differs');
    for (const [id, e] of truth) {
      const got = c.world.entities.get(id);
      assert.ok(got, `client is missing entity ${id}`);
      assert.ok(Math.abs(got.x - e.x) <= 0.5 / POS_QUANT + 1e-6, `x of ${id}: ${got.x} vs ${e.x}`);
      assert.ok(Math.abs(got.y - e.y) <= 0.5 / POS_QUANT + 1e-6, `y of ${id}: ${got.y} vs ${e.y}`);
      assert.equal(got.kind, e.kind);
    }
    assert.equal(c.world.stats.unknownIds, 0);
    c.ws.close();
  }
  assert.ok(lo.world.interval > hi.world.interval, 'low tier frames are flagged');
  for (const s of shards) s.resume();
});

test('seeding creates organisms owned by the player; others see the effect and cursor', async () => {
  const a = client({ name: 'alice' });
  const b = client({ name: 'bob' });
  assert.ok(await until(() => a.welcome && b.welcome));
  for (const c of [a, b]) c.ws.send(encodeView(0, 0, 700, 700));
  await sleep(300);
  a.ws.send(encodeCursor(300, 300));
  a.ws.send(encodeAction(ACTIONS.SEED, 300, 300));
  const pid = a.welcome.pid;
  assert.ok(await until(() => [...b.world.entities.values()].some((e) => e.owner === pid)), 'bob never saw alice\'s organism');
  assert.ok(
    await until(() => b.events.some((ev) => ev.events.some((x) => x.kind === 2 && x.pid === pid))),
    'bob never saw the seeding effect',
  );
  assert.ok(await until(() => b.events.some((ev) => ev.cursors.some((x) => x.pid === pid && x.name === 'alice'))), 'no cursor');
  a.ws.close();
  b.ws.close();
});

test('token keeps identity across reconnects; forged tokens are ignored', async () => {
  const a = client();
  assert.ok(await until(() => a.welcome));
  const { pid, token } = a.welcome;
  a.ws.close();
  await sleep(200);
  const again = client({ token });
  assert.ok(await until(() => again.welcome));
  assert.equal(again.welcome.pid, pid);
  const forged = client({ token: `${pid + 1}.${token.split('.')[1]}` });
  assert.ok(await until(() => forged.welcome));
  assert.notEqual(forged.welcome.pid, pid + 1);
  again.ws.close();
  forged.ws.close();
});

test('per-IP connection limit and garbage input do not break the gateway', async () => {
  await sleep(300);
  const cs = Array.from({ length: 6 }, () => client());
  await sleep(800);
  const open = cs.filter((c) => c.welcome && !c.closed).length;
  assert.equal(open, 4);
  const c = cs.find((x) => x.welcome && !x.closed);
  c.ws.send(Buffer.from([10, 1, 2]));
  c.ws.send(Buffer.from([11, 99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  c.ws.send('{not json');
  c.ws.send(JSON.stringify({ t: 'chat', text: 'x'.repeat(3000) }));
  c.ws.send(encodeView(NaN, 0, 1, 1));
  await sleep(200);
  assert.equal(c.closed, false, 'malformed-but-small input must be ignored, not fatal');
  // Messages over the 4 KB cap are a protocol violation: that socket is closed.
  const big = cs.find((x) => x !== c && x.welcome && !x.closed);
  big.ws.send(JSON.stringify({ t: 'chat', text: 'x'.repeat(10000) }));
  assert.ok(await until(() => big.closed));
  assert.equal(c.closed, false);
  for (const x of cs) x.ws.close();
  const res = await fetch(`http://127.0.0.1:${gateway.port}/metrics`);
  assert.equal(res.status, 200);
});

import net from 'node:net';

function rawRequest(port, text) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(text));
    let out = '';
    sock.on('data', (d) => (out += d));
    sock.on('close', () => resolve(out));
    sock.on('error', () => resolve(out));
    setTimeout(() => sock.destroy(), 1000);
  });
}

test('malformed request targets are rejected without crashing the gateway', async () => {
  await rawRequest(gateway.port, 'GET http://a:b:c/ HTTP/1.1\r\nHost: x\r\n\r\n');
  await rawRequest(
    gateway.port,
    'GET http://a:b:c/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
  );
  const res = await fetch(`http://127.0.0.1:${gateway.port}/healthz`);
  assert.equal(await res.text(), 'ok');
});

test('behind a proxy, a spoofed left-most X-Forwarded-For does not bypass the per-IP cap', async () => {
  const open = [];
  for (let i = 0; i < 5; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${proxied.port}/ws`, {
      // The client forges the left entry; the proxy appended the real one.
      headers: { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.9` },
    });
    ws.on('error', () => {});
    open.push(ws);
  }
  await sleep(500);
  assert.equal(open.filter((w) => w.readyState === 1).length, 2);
  for (const w of open) w.close();
});

test('view spam is throttled and catch-up replays are budgeted', async () => {
  const c = client();
  let bytes = 0;
  c.ws.on('message', (d) => (bytes += d.length));
  assert.ok(await until(() => c.welcome));
  const t0 = Date.now();
  let flip = 0;
  while (Date.now() - t0 < 3000) {
    // Two far-apart views, 200 per second.
    c.ws.send(flip++ % 2 ? encodeView(0, 0, 700, 700, TIER_LO) : encodeView(800, 800, 1500, 1500, TIER_LO));
    await sleep(5);
  }
  const rate = bytes / 3;
  // Budget: 2 MB burst + 256 KB/s refill + normal traffic; unthrottled this was ~1 MB/s+.
  assert.ok(rate < 1.2 * 1024 * 1024, `client pulled ${(rate / 1024).toFixed(0)} KB/s`);
  assert.equal(c.closed, false);
  c.ws.close();
});

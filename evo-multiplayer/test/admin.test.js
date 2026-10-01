// Moderation across gateways: admin API auth, mute / kick / ban (identity
// and IP), lifting, persistence across a control-shard restart, blocklist.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startShard } from '../src/server/shard-node.js';
import { startGateway } from '../src/server/gateway-node.js';
import { loadGame } from '../src/server/game-loader.js';
import { encodeView, encodeCursor, decodeEvents, unpackBatch, S_EVENTS } from '../src/shared/protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(25);
  }
  return false;
}

const base = 30000 + Math.floor(Math.random() * 9000);
const topology = { world: { chunksX: 4, chunksY: 4 }, shards: [`ws://127.0.0.1:${base}`, `ws://127.0.0.1:${base + 1}`] };
const secret = 'cluster';
const ADMIN = 'let-me-in';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-admin-'));
const blocklist = path.join(dataDir, 'blocklist.txt');
fs.writeFileSync(blocklist, '# comment\nbadword\n');
let game;
let shards = [];
let gw1;
let gw2;

const startS = (i) => startShard({ shard: i, port: base + i, topology, secret, game, quiet: true, dataDir, balance: false, bootWait: 3000 });
const startG = () =>
  startGateway({ port: 0, host: '127.0.0.1', topology, secret, tokenSecret: 'tok', quiet: true, adminToken: ADMIN, blocklist, maxPerIp: 50 });

before(async () => {
  game = await loadGame('soup');
  shards = await Promise.all([0, 1].map(startS));
  gw1 = await startG();
  gw2 = await startG();
  await sleep(500);
});

after(() => {
  gw1?.close();
  gw2?.close();
  for (const s of shards) s.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function admin(gw, op, body, token = ADMIN) {
  return fetch(`http://127.0.0.1:${gw.port}/admin/api/${op}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

function client(gw, hello = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws`);
  const c = { ws, welcome: null, closeCode: null, chats: [], notices: [], opened: false };
  ws.on('open', () => {
    c.opened = true;
    ws.send(JSON.stringify({ t: 'hello', name: 'p', ...hello }));
  });
  ws.on('close', (code) => (c.closeCode = code));
  ws.on('error', () => {});
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const m = JSON.parse(data.toString());
      if (m.t === 'welcome') c.welcome = m;
      if (m.t === 'notice') c.notices.push(m.text);
      return;
    }
    unpackBatch(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), (u8) => {
      if (u8[0] !== S_EVENTS || !c.welcome) return;
      for (const ev of decodeEvents(u8, c.welcome.world, c.welcome.posQuant).events) if (ev.kind === 1) c.chats.push(ev);
    });
  });
  return c;
}

async function joined(c) {
  assert.ok(await until(() => c.welcome), 'no welcome');
  c.ws.send(encodeView(0, 0, 600, 600));
  c.ws.send(encodeCursor(200, 200));
  await sleep(200);
}

test('admin API requires the token', async () => {
  assert.equal((await admin(gw1, 'state', null, '')).status, 401);
  assert.equal((await admin(gw1, 'state', null, 'wrong')).status, 401);
  const ok = await admin(gw1, 'state');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.shardCount, 2);
});

test('mute (issued via gateway 2) silences a player on gateway 1; chat log and blocklist work', async () => {
  const a = client(gw1, { name: 'alice' });
  const b = client(gw2, { name: 'bob' });
  await joined(a);
  await joined(b);
  a.ws.send(JSON.stringify({ t: 'chat', text: 'hello badword world' }));
  assert.ok(await until(() => b.chats.some((m) => m.text === 'hello ******* world')), 'filtered chat not seen');
  const st = await admin(gw2, 'state');
  assert.ok(st.body.chat.some((m) => m.pid === a.welcome.pid && m.text.includes('*******')), 'chat log');
  assert.equal((await admin(gw2, 'mute', { pid: a.welcome.pid, minutes: 5 })).status, 200);
  await sleep(300);
  await sleep(1300); // chat rate limit
  a.ws.send(JSON.stringify({ t: 'chat', text: 'can you hear me' }));
  assert.ok(await until(() => a.notices.length > 0), 'muted player not told');
  await sleep(500);
  assert.ok(!b.chats.some((m) => m.text === 'can you hear me'), 'muted chat was delivered');
  a.ws.close();
  b.ws.close();
});

test('kick disconnects on any gateway; the player may come back', async () => {
  const a = client(gw1);
  await joined(a);
  assert.equal((await admin(gw2, 'kick', { pid: a.welcome.pid })).status, 200);
  assert.ok(await until(() => a.closeCode === 4001));
  const again = client(gw1, { token: a.welcome.token });
  assert.ok(await until(() => again.welcome));
  assert.equal(again.welcome.pid, a.welcome.pid);
  again.ws.close();
});

test('identity ban: kicked everywhere, token refused, same IP may still play; IP ban refuses the address; lift restores', async () => {
  const a = client(gw1);
  await joined(a);
  const pid = a.welcome.pid;
  const r = await admin(gw2, 'ban', { pid, minutes: 60, reason: 'test' });
  assert.equal(r.status, 200);
  assert.ok(!r.body.ipHash, 'IP must not be banned unless asked');
  assert.ok(await until(() => a.closeCode === 4003), 'banned player not disconnected');
  const back = client(gw2, { token: a.welcome.token });
  assert.ok(await until(() => back.closeCode === 4003), 'banned token accepted');
  const fresh = client(gw1);
  assert.ok(await until(() => fresh.welcome), 'innocent player on the same IP refused');

  // Now an IP ban (everything here is 127.0.0.1).
  // Registrations reach the control shard in batches; until then an IP ban
  // is refused with an error rather than silently degraded.
  let ipBan;
  assert.ok(await until(async () => (ipBan = await admin(gw1, 'ban', { pid: fresh.welcome.pid, minutes: 60, withIp: true })).status === 200));
  assert.ok(ipBan.body.ipHash);
  assert.ok(await until(() => fresh.closeCode === 4003));
  const blocked = client(gw2);
  assert.ok(await until(() => blocked.closeCode !== null && !blocked.opened), 'IP-banned address accepted');

  // Lift the IP ban; the identity ban stays.
  assert.equal((await admin(gw1, 'lift', { id: ipBan.body.id })).status, 200);
  await sleep(200);
  const ok = client(gw2);
  assert.ok(await until(() => ok.welcome), 'address still refused after lift');
  ok.ws.close();
  const stillBanned = client(gw1, { token: a.welcome.token });
  assert.ok(await until(() => stillBanned.closeCode === 4003));
});

test('sanctions persist across a control-shard restart', async () => {
  const before = (await admin(gw1, 'state')).body.sanctions;
  assert.ok(before.length >= 1);
  assert.ok(fs.existsSync(path.join(dataDir, 'bans.json')));
  shards[0].close();
  await sleep(300);
  shards[0] = await startS(0);
  assert.ok(
    await until(async () => {
      const r = await admin(gw1, 'state');
      return r.status === 200 && r.body.sanctions.length === before.length;
    }, 10000),
    'sanctions lost after restart',
  );
});

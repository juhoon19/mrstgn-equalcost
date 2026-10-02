// Accounts, social, trading and moderation end to end: 2 meta replicas,
// 1 shard, 2 gateways; players on different gateways whose accounts live on
// different replicas. Set TEST_DATABASE_URL=postgres://... to run on Postgres
// (that database is truncated; run Postgres files with --test-concurrency=1).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startShard } from '../src/server/shard-node.js';
import { startGateway } from '../src/server/gateway-node.js';
import { startMeta } from '../src/meta/meta-node.js';
import { openStore } from '../src/meta/store.js';
import { loadGame } from '../src/server/game-loader.js';
import { encodeView, encodeAction, ACTIONS } from '../src/shared/protocol.js';
import { RELEASE_FEE } from '../src/meta/economy.js';
import { powSolve, powCheck } from '../src/shared/pow.js';
import { STARTER_GRANT } from '../src/meta/accounts.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(25);
  }
  return false;
}

const base = 35000 + Math.floor(Math.random() * 4500); // own range per test file
const topology = { world: { chunksX: 4, chunksY: 4 }, shards: [`ws://127.0.0.1:${base}`] };
const metaUrls = [`ws://127.0.0.1:${base + 10}`, `ws://127.0.0.1:${base + 11}`];
const secret = 'cluster';
const ADMIN = 'admin-token';
let store;
let metas = [];
let shard;
let gw1;
let gw2;

before(async () => {
  const url = process.env.TEST_DATABASE_URL || 'sqlite::memory:';
  store = await openStore(url);
  if (url.startsWith('postgres')) {
    await store.exec('TRUNCATE accounts, sessions, balances, ledger, items, item_log, listings, trades, friends, blocks, messages, reports, audit, throttle RESTART IDENTITY');
  }
  metas = await Promise.all(metaUrls.map((u, i) => startMeta({ id: i, urls: metaUrls, port: base + 10 + i, secret, store, quiet: true, registerPerHour: 1000 })));
  const game = await loadGame('soup');
  shard = await startShard({ shard: 0, port: base, topology, secret, game, quiet: true, balance: false, metaUrls, worldId: 'test', rewardEvery: 0.5, rewardCap: 3 });
  const g = () => startGateway({ port: 0, host: '127.0.0.1', topology, secret, tokenSecret: 'tok', quiet: true, adminToken: ADMIN, maxPerIp: 100, metaUrls, registerPerHour: 1000, powBits: 0 });
  gw1 = await g();
  gw2 = await g();
  await sleep(400);
});

after(async () => {
  gw1?.close();
  gw2?.close();
  shard?.close();
  for (const m of metas) await m.close();
  await store?.close();
});

// A websocket game client with an rpc() helper.
function client(gw, hello = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws`);
  const c = { ws, welcome: null, closeCode: null, events: [], notices: [], pending: new Map(), seq: 0 };
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'p', ...hello })));
  ws.on('close', (code) => (c.closeCode = code));
  ws.on('error', () => {});
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const m = JSON.parse(data.toString());
    if (m.t === 'welcome') c.welcome = m;
    else if (m.t === 'notice') c.notices.push(m.text);
    else if (m.t === 'ev') c.events.push(m.ev);
    else if (m.t === 'rpcr') {
      const p = c.pending.get(m.id);
      c.pending.delete(m.id);
      if (p) m.ok ? p.resolve(m.r) : p.reject(Object.assign(new Error(m.msg), { code: m.code }));
    }
  });
  c.rpc = (m, a = {}) =>
    new Promise((resolve, reject) => {
      const id = ++c.seq;
      c.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ t: 'rpc', id, m, a }));
    });
  c.ready = () => until(() => c.welcome);
  c.close = () => ws.close();
  return c;
}

async function account(gw, name) {
  const g = client(gw);
  await g.ready();
  const reg = await g.rpc('auth.register', { name, password: 'password123' });
  g.close();
  const c = client(gw, { session: reg.token });
  await c.ready();
  c.reg = reg;
  return c;
}

function adminHttp(gw, op, body, token = ADMIN) {
  return fetch(`http://127.0.0.1:${gw.port}/admin/api/${op}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

let alice;
let bob;

test('register, session hello, guests cannot use account features', async () => {
  const guest = client(gw1);
  await guest.ready();
  assert.equal(guest.welcome.account, null);
  assert.ok(guest.welcome.name.startsWith('游客·'), 'guests are marked when accounts exist');
  assert.ok(guest.welcome.pid >= 2 ** 30, 'guest ids are outside the account range');
  await assert.rejects(guest.rpc('wallet.get'), { code: 'LOGIN_REQUIRED' });
  await assert.rejects(guest.rpc('item.capture', { entityId: 1, x: 1, y: 1 }), { code: 'LOGIN_REQUIRED' });
  await assert.rejects(guest.rpc('admin.role', { id: 1, role: 'admin' }), { code: 'NO_METHOD' }, 'internal methods are not reachable');
  guest.close();

  alice = await account(gw1, 'alice');
  bob = await account(gw2, 'bob');
  assert.equal(alice.welcome.account.name, 'alice');
  assert.equal(alice.welcome.pid, alice.welcome.account.id, 'world identity = account id');
  assert.equal(alice.reg.recoveryCodes.length, 8);
  // alice and bob are homed on different meta replicas (ids 1 and 2).
  assert.notEqual(alice.welcome.pid % 2, bob.welcome.pid % 2);
  const w = await alice.rpc('wallet.get');
  assert.equal(w.balance, STARTER_GRANT);
  // A bad session falls back to guest, and says so.
  const stale = client(gw2, { session: 'Sbogus' });
  await stale.ready();
  assert.equal(stale.welcome.account, null);
  assert.ok(await until(() => stale.events.some((e) => e.type === 'session-expired')));
  stale.close();
});

test('friends, presence and private messages across gateways and replicas', async () => {
  const r = await alice.rpc('friends.request', { name: 'bob' });
  assert.equal(r.status, 'pending');
  assert.ok(await until(() => bob.events.some((e) => e.type === 'friend' && e.status === 'incoming')), 'bob is told about the request');
  await bob.rpc('friends.respond', { from: alice.welcome.pid, accept: true });
  assert.ok(await until(() => alice.events.some((e) => e.type === 'friend' && e.status === 'accepted')));
  const list = await alice.rpc('friends.list');
  assert.deepEqual(
    list.map((f) => [f.name, f.status, f.online]),
    [['bob', 'accepted', true]],
  );

  await alice.rpc('dm.send', { to: bob.welcome.pid, text: '你好，我的微信 abc123（好友之间可以）' });
  assert.ok(await until(() => bob.events.some((e) => e.type === 'dm' && e.msg.text.startsWith('你好'))), 'DM delivered live');
  const unread = await bob.rpc('dm.unread');
  assert.equal(unread[0].n, 1);
  await bob.rpc('dm.read', { with: alice.welcome.pid });
  assert.equal((await bob.rpc('dm.unread')).length, 0);
  const hist = await bob.rpc('dm.history', { with: alice.welcome.pid });
  assert.equal(hist.length, 1);

  // Presence: bob goes offline, alice is told.
  const bobToken = bob.reg.token;
  bob.close();
  assert.ok(await until(() => alice.events.some((e) => e.type === 'presence' && e.online === false)));
  bob = client(gw2, { session: bobToken });
  await bob.ready();
  bob.reg = { token: bobToken };
  assert.ok(await until(() => alice.events.some((e) => e.type === 'presence' && e.online === true)));
});

test('strangers: contact info blocked, privacy and blocks enforced, reports keep server-side evidence', async () => {
  const carol = await account(gw2, 'carol');
  await assert.rejects(carol.rpc('dm.send', { to: alice.welcome.pid, text: '加我微信 12345678 便宜卖' }), { code: 'MODERATED' });
  await carol.rpc('dm.send', { to: alice.welcome.pid, text: 'hi there' });
  await alice.rpc('auth.privacy', { dm: 'friends' });
  await assert.rejects(carol.rpc('dm.send', { to: alice.welcome.pid, text: 'hello?' }), { code: 'PRIVACY' });
  await alice.rpc('auth.privacy', { dm: 'everyone' });
  await alice.rpc('block.add', { id: carol.welcome.pid });
  await assert.rejects(carol.rpc('dm.send', { to: alice.welcome.pid, text: 'again' }), { code: 'BLOCKED' });
  await assert.rejects(carol.rpc('trade.open', { with: alice.welcome.pid }), { code: 'BLOCKED' });
  const rep = await alice.rpc('report.create', { target: carol.welcome.pid, reason: 'spam' });
  assert.ok(rep.report > 0);
  const reports = await adminHttp(gw1, 'meta/reports');
  assert.equal(reports.status, 200);
  assert.equal(reports.body[0].context[0].text, 'hi there', 'evidence is the stored message, not client-supplied');
  carol.close();
});

test('capture an organism, release it, sell it on the market, trade', async () => {
  const cs = alice.welcome.world.chunkSize;
  const x = cs * 0.5;
  const y = cs * 0.5;
  alice.ws.send(encodeView(0, 0, cs, cs));
  await sleep(300);
  alice.ws.send(encodeAction(ACTIONS.SEED, x, y));
  const me = alice.welcome.pid;
  let cell = null;
  assert.ok(
    await until(() => {
      cell = shard.region.local.find((e) => e.owner === me && e.kind === 1 && !e.dead);
      return cell;
    }),
    'seeded cell exists',
  );
  // Someone else cannot capture alice's organism.
  bob.ws.send(encodeView(0, 0, cs, cs));
  await sleep(300);
  await assert.rejects(bob.rpc('item.capture', { entityId: cell.id, x: cell.x, y: cell.y }), { code: 'NOT_YOURS' });
  const cap = await alice.rpc('item.capture', { entityId: cell.id, x: cell.x, y: cell.y });
  assert.ok(cap.item > 0 && cap.created);
  assert.ok(await until(() => !shard.region.local.some((e) => e.id === cell.id)), 'organism left the world');
  await assert.rejects(alice.rpc('item.capture', { entityId: cell.id, x: cell.x, y: cell.y }), { code: 'GONE' });
  let w = await alice.rpc('wallet.get');
  assert.equal(w.items.length, 1);
  assert.equal(w.items[0].data.game, 'soup');

  // Release: item consumed, fee burned, a new cell of alice's lineage appears.
  const before = w.balance;
  const rel = await alice.rpc('item.release', { item: cap.item, x, y });
  assert.ok(rel.entity > 0);
  assert.ok(await until(() => shard.region.local.some((e) => e.id === rel.entity && e.owner === me)));
  w = await alice.rpc('wallet.get');
  assert.equal(w.items.length, 0);
  assert.ok(w.balance <= before - RELEASE_FEE + 10, 'fee charged (rewards may have arrived meanwhile)');
  await assert.rejects(alice.rpc('item.release', { item: cap.item, x, y }), { code: 'ITEM_UNAVAILABLE' });

  // Capture again and sell to bob.
  const cap2 = await alice.rpc('item.capture', { entityId: rel.entity, x, y }).catch(async () => {
    const c2 = shard.region.local.find((e) => e.owner === me && e.kind === 1 && !e.dead);
    return alice.rpc('item.capture', { entityId: c2.id, x: c2.x, y: c2.y });
  });
  const { listing } = await alice.rpc('market.list', { item: cap2.item, price: 40 });
  const browse = await bob.rpc('market.browse', {});
  assert.ok(browse.some((l) => l.id === listing));
  await bob.rpc('market.buy', { listing });
  assert.ok(await until(() => alice.events.some((e) => e.type === 'sold' && e.listing === listing)), 'seller notified live');
  const bw = await bob.rpc('wallet.get');
  assert.equal(bw.items.length, 1);

  // P2P: bob gives the item back for 30 coins.
  const tr = await bob.rpc('trade.open', { with: me });
  await bob.rpc('trade.offer', { id: tr.id, items: [bw.items[0].id], coins: 0 });
  const v = await alice.rpc('trade.offer', { id: tr.id, items: [], coins: 30 });
  await bob.rpc('trade.confirm', { id: tr.id, version: v.version });
  const done = await alice.rpc('trade.confirm', { id: tr.id, version: v.version });
  assert.equal(done.status, 'done');
  assert.ok(await until(() => bob.events.some((e) => e.type === 'trade' && e.trade.status === 'done')));
  assert.equal((await alice.rpc('wallet.get')).items.length, 1);
  const st = await adminHttp(gw2, 'meta/economy');
  assert.equal(st.body.balanceSum, 0, 'currency conserved');
});

test('lineage rewards are minted once per period', async () => {
  const cs = alice.welcome.world.chunkSize;
  for (let i = 0; i < 3; i++) {
    alice.ws.send(encodeAction(ACTIONS.SEED, cs * (0.3 + i * 0.2), cs * 0.4));
    await sleep(700); // seed cooldown
  }
  const eco = metas[0].economy;
  const before = await eco.balance(alice.welcome.pid);
  assert.ok(
    await until(async () => (await eco.balance(alice.welcome.pid)) > before, 4000),
    'alice earns for living descendants',
  );
  const r = await store.query("SELECT key, count(*) AS n FROM ledger WHERE kind = 'reward' GROUP BY key HAVING count(*) > 1");
  assert.equal(r.rows.length, 0);
});

test('world chat moderation: links blocked, repeated offences auto-mute the account', async () => {
  alice.ws.send(JSON.stringify({ t: 'chat', text: 'free stuff at scam.xyz/login' }));
  assert.ok(await until(() => alice.notices.some((n) => n.includes('外部链接'))));
  for (let i = 0; i < 5; i++) {
    alice.ws.send(JSON.stringify({ t: 'chat', text: `go to bad${i}.top now` }));
    await sleep(1300); // world chat is limited to one line per 1.2 s
  }
  assert.ok(await until(() => alice.events.some((e) => e.type === 'muted')), 'auto-mute pushed');
  await assert.rejects(alice.rpc('dm.send', { to: bob.welcome.pid, text: 'hi' }), { code: 'MUTED' });
  const audit = await adminHttp(gw1, 'meta/audit');
  assert.ok(audit.body.some((a) => a.action === 'auto-mute'));
});

test('staff accounts: login, roles, sanctions reach live sockets, audit trail', async () => {
  const mod = await account(gw1, 'moddy');
  await metas[0].accounts.setRole(mod.welcome.pid, 'mod');
  const bad = await fetch(`http://127.0.0.1:${gw1.port}/admin/api/login`, {
    method: 'POST',
    body: JSON.stringify({ name: 'bob', password: 'password123' }),
  });
  assert.equal(bad.status, 403, 'players cannot log into the admin console');
  const res = await fetch(`http://127.0.0.1:${gw1.port}/admin/api/login`, {
    method: 'POST',
    body: JSON.stringify({ name: 'moddy', password: 'password123' }),
  }).then((r) => r.json());
  assert.ok(res.token);
  const who = await adminHttp(gw2, 'whoami', null, res.token);
  assert.equal(who.body.role, 'mod');
  // A mod can mute but not ban or change roles.
  assert.equal((await adminHttp(gw2, 'meta/sanction', { id: bob.welcome.pid, banMinutes: 5 }, res.token)).status, 403);
  assert.equal((await adminHttp(gw2, 'meta/role', { id: mod.welcome.pid, role: 'admin' }, res.token)).status, 403);
  assert.equal((await adminHttp(gw2, 'move', { chunk: 0, to: 0 }, res.token)).status, 403);
  const acc = await adminHttp(gw2, 'meta/account?name=bob', null, res.token);
  assert.equal(acc.body.account.name, 'bob');
  assert.equal(acc.body.online, true);
  // ADMIN_TOKEN bans bob: his live socket (other gateway) is closed.
  const ban = await adminHttp(gw1, 'meta/sanction', { id: bob.welcome.pid, banMinutes: 60, reason: 'test' });
  assert.equal(ban.status, 200);
  assert.ok(await until(() => bob.closeCode === 4003), 'banned account disconnected');
  const again = client(gw2, { session: bob.reg.token });
  await until(() => again.closeCode !== null || again.welcome);
  assert.equal(again.welcome?.account ?? null, null, 'banned session no longer logs in');
  const audit = await adminHttp(gw1, 'meta/audit');
  assert.ok(audit.body.some((a) => a.action === 'sanction' && a.target === `acct:${bob.welcome.pid}`));
  again.close();
  mod.close();
  alice.close();
});

// ------------------------------------------------------ integration seams

test('a guest who registers keeps the lineage they grew as a guest', async () => {
  const g = client(gw1, { name: 'sprout' });
  await g.ready();
  const guestPid = g.welcome.pid;
  const cs = g.welcome.world.chunkSize;
  g.ws.send(encodeView(cs, cs, cs * 2, cs * 2));
  await sleep(300);
  // Re-seed until it takes (under load the view subscription can lag).
  let seeded = false;
  for (let k = 0; k < 20 && !seeded; k++) {
    g.ws.send(encodeAction(ACTIONS.SEED, cs * 1.5, cs * 1.5));
    seeded = await until(() => shard.region.local.some((e) => e.owner === guestPid && !e.dead), 700);
  }
  assert.ok(seeded, 'guest lineage exists');
  const reg = await g.rpc('auth.register', { name: 'sprout', password: 'password123' });
  const acct = reg.account.id;
  assert.ok(
    await until(() => shard.region.local.some((e) => e.owner === acct && !e.dead) && !shard.region.local.some((e) => e.owner === guestPid && !e.dead)),
    'lineage now belongs to the account',
  );
  g.close();
  const s = client(gw2, { session: reg.token });
  await s.ready();
  assert.equal(s.welcome.pid, acct);
  // ...so the account can capture what it grew as a guest.
  const cell = shard.region.local.find((e) => e.owner === acct && e.kind === 1 && !e.dead);
  s.ws.send(encodeView(cs, cs, cs * 2, cs * 2));
  await sleep(300);
  if (cell) {
    const r = await s.rpc('item.capture', { entityId: cell.id, x: cell.x, y: cell.y }).catch((err) => err);
    assert.ok(r.item > 0 || r.code === 'GONE', `capture after adoption: ${r.code || 'ok'}`);
  }
  s.close();
});

test('zone handover: one account on two gateways at once keeps presence and delivery', async () => {
  const dave = await account(gw1, 'dave');
  const erin = await account(gw2, 'erin');
  await dave.rpc('friends.request', { name: 'erin' });
  await erin.rpc('friends.request', { name: 'dave' }); // mutual request = accepted
  // Make-before-break: dave opens the new zone's gateway, then closes the old.
  const dave2 = client(gw2, { session: dave.reg.token });
  await dave2.ready();
  assert.equal(dave2.welcome.pid, dave.welcome.pid);
  erin.events.length = 0;
  dave.close();
  await sleep(400);
  assert.ok(!erin.events.some((e) => e.type === 'presence' && e.online === false), 'no false "offline" during handover');
  assert.equal((await erin.rpc('friends.list'))[0].online, true);
  await erin.rpc('dm.send', { to: dave.welcome.pid, text: 'still there?' });
  assert.ok(await until(() => dave2.events.some((e) => e.type === 'dm' && e.msg.text === 'still there?')), 'DM reaches the new connection');
  dave2.close();
  assert.ok(await until(() => erin.events.some((e) => e.type === 'presence' && e.online === false)), 'offline once the last connection closes');
  erin.close();
});

test('world-side mute/ban from the chat log also sanction the account', async () => {
  const fay = await account(gw1, 'fay');
  const gus = await account(gw2, 'gus');
  const H = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
  const r = await fetch(`http://127.0.0.1:${gw1.port}/admin/api/mute`, { method: 'POST', headers: H, body: JSON.stringify({ pid: fay.welcome.pid, minutes: 30, reason: 'spam' }) });
  assert.equal(r.status, 200);
  await assert.rejects(fay.rpc('dm.send', { to: gus.welcome.pid, text: 'hi' }), { code: 'MUTED' }, 'chat-log mute also blocks DMs');
  const acc = await adminHttp(gw1, `meta/account?id=${fay.welcome.pid}`);
  assert.ok(acc.body.account.mutedUntil > Date.now() + 29 * 60000);
  // Lifting it in the world-side list lifts the account mute too.
  const sid = (await r.json()).id;
  await until(async () => (await adminHttp(gw1, 'state')).body.sanctions?.some((x) => x.id === sid));
  await sleep(200); // gateways receive the sanction list
  assert.equal((await adminHttp(gw1, 'lift', { id: sid })).status, 200);
  assert.ok(await until(async () => (await adminHttp(gw1, `meta/account?id=${fay.welcome.pid}`)).body.account.mutedUntil < Date.now()), 'account mute lifted');
  await fay.rpc('dm.send', { to: gus.welcome.pid, text: 'thanks' });
  fay.close();
  gus.close();
});

test('GUESTS_CAN_CHAT=false: guests are told to log in, accounts chat normally', async () => {
  const gw3 = await startGateway({ port: 0, host: '127.0.0.1', topology, secret, tokenSecret: 'tok', quiet: true, maxPerIp: 100, metaUrls, guestsCanChat: false, powBits: 0 });
  await sleep(300);
  const guest = client(gw3);
  await guest.ready();
  guest.ws.send(JSON.stringify({ t: 'chat', text: 'hello' }));
  assert.ok(await until(() => guest.notices.some((n) => n.includes('登录后才能聊天'))));
  guest.close();
  gw3.close();
});

test('meta replica failure: calls fail over, presence recovers when it returns', async () => {
  const hal = await account(gw1, 'hal');
  const ivy = await account(gw2, 'ivy');
  await hal.rpc('friends.request', { name: 'ivy' });
  await ivy.rpc('friends.request', { name: 'hal' });
  // Kill the replica that is home to hal.
  const h = hal.welcome.pid % 2;
  await metas[h].close();
  await sleep(300);
  const w = await hal.rpc('wallet.get');
  assert.equal(typeof w.balance, 'number', 'another replica serves the call');
  await ivy.rpc('dm.send', { to: hal.welcome.pid, text: 'stored while home is down' });
  // Bring it back on the same port.
  metas[h] = await startMeta({ id: h, urls: metaUrls, port: base + 10 + h, secret, store, quiet: true, registerPerHour: 1000 });
  assert.ok(
    await until(async () => (await ivy.rpc('friends.list')).find((f) => f.name === 'hal')?.online === true, 8000),
    'gateways re-announce hal after the replica restarts',
  );
  const unread = await hal.rpc('dm.unread');
  assert.ok(unread.some((u) => u.name === 'ivy'), 'message sent during the outage is waiting');
  await ivy.rpc('dm.send', { to: hal.welcome.pid, text: 'live again' });
  assert.ok(await until(() => hal.events.some((e) => e.type === 'dm' && e.msg.text === 'live again')), 'live delivery resumes');
  hal.close();
  ivy.close();
});

test('housekeeping removes expired sessions and messages past retention, nothing else', async () => {
  const before = (await store.query('SELECT count(*) AS n FROM messages')).rows[0].n;
  const sess = (await store.query('SELECT count(*) AS n FROM sessions')).rows[0].n;
  // Pretend two years have passed: every session expired, every message is old.
  const r = await metas[0].housekeep(Date.now() + 2 * 365 * 86400000);
  assert.equal(r.sessions, Number(sess));
  assert.equal(r.messages, Number(before));
  assert.ok(Number(before) > 0);
  // Money and items are never touched.
  const st = await adminHttp(gw1, 'meta/economy');
  assert.equal(st.body.balanceSum, 0);
  assert.ok(st.body.items >= 1);
});

test('revoked sessions close open sockets elsewhere; mods cannot lift bans', async () => {
  const kim = await account(gw1, 'kim');
  // The same account, logged in a second time on another gateway (e.g. a hijacker).
  const r = await (async () => {
    const g = client(gw2);
    await g.ready();
    const x = await g.rpc('auth.login', { name: 'kim', password: 'password123' });
    g.close();
    return x;
  })();
  const other = client(gw2, { session: r.token });
  await other.ready();
  assert.equal(other.welcome.account.name, 'kim');
  // The owner logs out everywhere: the other socket is closed, the owner's own
  // (whose session is also gone) too - nothing keeps trading on a dead session.
  await kim.rpc('auth.logoutAll');
  assert.ok(await until(() => other.closeCode === 4005), 'hijacked socket closed');
  assert.ok(await until(() => kim.closeCode === 4005));

  // A mod may lift mutes but not bans.
  const mod = await account(gw1, 'modlift');
  await metas[0].accounts.setRole(mod.welcome.pid, 'mod');
  const tok = (await fetch(`http://127.0.0.1:${gw1.port}/admin/api/login`, { method: 'POST', body: JSON.stringify({ name: 'modlift', password: 'password123' }) }).then((x) => x.json())).token;
  const g = client(gw1);
  await g.ready();
  const ban = await adminHttp(gw1, 'ban', { pid: g.welcome.pid, minutes: 60 });
  assert.equal(ban.status, 200);
  await until(async () => (await adminHttp(gw1, 'state')).body.sanctions?.some((x) => x.id === ban.body.id));
  await sleep(200);
  assert.equal((await adminHttp(gw1, 'lift', { id: ban.body.id }, tok)).status, 403);
  assert.equal((await adminHttp(gw1, 'lift', { id: ban.body.id })).status, 200);
  mod.close();
});

test('registration proof of work: required, single use, unforgeable', async () => {
  const gw = await startGateway({ port: 0, host: '127.0.0.1', topology, secret, tokenSecret: 'tok', quiet: true, maxPerIp: 100, metaUrls, registerPerHour: 1000, powBits: 12 });
  await sleep(300);
  const c = client(gw);
  await c.ready();
  await assert.rejects(c.rpc('auth.register', { name: 'nopow', password: 'password123' }), { code: 'POW' });
  const ch = await c.rpc('auth.challenge');
  assert.equal(ch.bits, 12);
  const nonce = await powSolve(ch.challenge, ch.bits);
  let bad = 0;
  while (await powCheck(ch.challenge, bad, ch.bits)) bad++;
  await assert.rejects(c.rpc('auth.register', { name: 'badpow', password: 'password123', pow: { challenge: ch.challenge, nonce: bad } }), { code: 'POW' });
  const ok = await c.rpc('auth.register', { name: 'withpow', password: 'password123', pow: { challenge: ch.challenge, nonce } });
  assert.equal(ok.account.name, 'withpow');
  await assert.rejects(c.rpc('auth.register', { name: 'reuse', password: 'password123', pow: { challenge: ch.challenge, nonce } }), { code: 'POW' }, 'one use');
  const [ts, rnd] = ch.challenge.split('.');
  const forged = `${ts}.${rnd}.AAAAAAAAAAAAAAAA`;
  await assert.rejects(c.rpc('auth.register', { name: 'forged', password: 'password123', pow: { challenge: forged, nonce: await powSolve(forged, 12) } }), { code: 'POW' });
  c.close();
  gw.close();
});

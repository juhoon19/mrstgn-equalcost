// Soak / chaos test: N simulated players with different behaviour hit a full
// cluster at once, then every invariant is checked.
//
//   node bench/soak.js --url ws://127.0.0.1:8080/ws --n 1000 --seconds 120 \
//        --admin-token TOKEN --db postgres://... [--log cluster.log]
//
// Personas (share of bots):
//   guest    20%  never logs in: looks around, uses tools, chats
//   player   25%  account: seeds, captures its organisms, releases, sells and buys
//   trader   15%  account: P2P trades with others (offers, version-checked
//                 confirms, counter-offers, cancels), races for hot listings
//   social   20%  account: friend requests/accepts, DMs, unread/read, privacy
//   troll    10%  account: links/contact-info spam, repeats, DMs strangers,
//                 reports and blocks people
//   chaos    10%  account: malformed frames, unknown methods, absurd
//                 arguments, a second tab on the same session, zone jumps,
//                 hanging up mid-request, log out everywhere, re-login
// Plus one moderator (HTTP admin API) muting, lifting and banning.
//
// Reported: every RPC error code per method, any error outside the expected
// business codes (INTERNAL, TIMEOUT, unanswered calls...), unexpected close
// codes, world-replica inconsistencies (unknown ids / duplicate adds) and,
// with --db, the database invariants (money conserved, no negative balance,
// escrow and listing consistency, item history, quotas, reward cap, banned
// accounts have no sessions, blocked pairs are not friends).

import WebSocket from 'ws';
import { encodeView, encodeAction, ACTIONS, unpackBatch, S_CHUNK, ClientWorld } from '../src/shared/protocol.js';
import { powSolve } from '../src/shared/pow.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const URL0 = args.url || 'ws://127.0.0.1:8080/ws';
const HTTP = URL0.replace(/^ws/, 'http').replace(/\/ws$/, '');
const N = Number(args.n || 200);
const SECONDS = Number(args.seconds || 60);
const ADMIN = args['admin-token'] || '';
const RUN = args.prefix || `s${Date.now() % 100000}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
const chance = (p) => Math.random() < p;
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1);

// ----------------------------------------------------------- bookkeeping
const ops = new Map(); // method -> { ok, codes: Map }
const anomalies = []; // { t, what, detail }
const closes = new Map(); // code -> n
const faults = []; // [start, end] windows (ms since t0) where failures are expected
let pushes = 0;
let decoded = [];
const worldEvents = [];
const EXPECTED = new Set([
  'RATE', 'LIMIT', 'BUSY', 'GONE', 'NOT_YOURS', 'NOT_VISIBLE', 'MOVED', 'ITEM_UNAVAILABLE', 'INSUFFICIENT_FUNDS',
  'UNAVAILABLE', 'NOT_FOUND', 'CHANGED', 'BLOCKED', 'PRIVACY', 'MUTED', 'MODERATED', 'TOO_MANY', 'BAD_ARG', 'BAD_PRICE',
  'BAD_AMOUNT', 'NAME_TAKEN', 'BAD_LOGIN', 'THROTTLED', 'LOGIN_REQUIRED', 'ALREADY_CAPTURED', 'BAD_NAME', 'BAD_PASSWORD',
  'TOTP_ENABLED', 'BAD_TRANSFER', 'BANNED', 'UNSUPPORTED', 'BAD_ITEM',
]);
const CHAOS_EXPECTED = new Set(['NO_METHOD', 'POW', 'BAD_ARG']);
const inFault = () => faults.some(([a, b]) => Date.now() - t0 >= a && Date.now() - t0 <= b + 3000);
function note(m, code, chaos) {
  let o = ops.get(m);
  if (!o) ops.set(m, (o = { ok: 0, codes: new Map() }));
  if (!code) return void o.ok++;
  o.codes.set(code, (o.codes.get(code) || 0) + 1);
  if (EXPECTED.has(code) || (chaos && CHAOS_EXPECTED.has(code))) return;
  if (inFault() && ['META_DOWN', 'TIMEOUT', 'SHARD_DOWN', 'SPAWN_FAILED', 'OFFLINE'].includes(code)) return;
  anomalies.push({ t: ts(), what: `rpc ${m} -> ${code}` });
}

// ------------------------------------------------------------------ client
class Conn {
  constructor(bot, url, hello) {
    this.bot = bot;
    this.pending = new Map();
    this.seq = 0;
    this.world = null;
    this.ws = new WebSocket(url, { perMessageDeflate: false });
    this.ready = new Promise((resolve) => {
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name: `${bot.persona}${bot.i}`, ...hello })));
      this.ws.on('message', (data, isBinary) => {
        if (isBinary) {
          if (this.world) {
            const now = performance.now();
            unpackBatch(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), (m) => {
              if (m[0] !== S_CHUNK) return;
              const before = this.world.stats.dupAdds + this.world.stats.unknownIds;
              this.world.applyChunk(m, now);
              if (this.world.stats.dupAdds + this.world.stats.unknownIds > before && worldEvents.length < 200) {
                // Which chunk, which frame, keyframe or delta, and when.
                const chunk = m[1] | 0;
                worldEvents.push(`${ts()}s bot ${bot.i} chunk-byte ${chunk} dup=${this.world.stats.dupAdds} unknown=${this.world.stats.unknownIds} gw=${this.welcome?.gateway} zone=${this.welcome?.zone}`);
              }
            });
          }
          return;
        }
        let m;
        try {
          m = JSON.parse(data.toString());
        } catch {
          return anomalies.push({ t: ts(), what: 'server sent invalid JSON' });
        }
        if (m.t === 'welcome') {
          this.welcome = m;
          if (bot.decode) {
            this.world = new ClientWorld(m.world, m.posQuant);
            decoded.push(this.world);
          }
          resolve(true);
        } else if (m.t === 'rpcr') {
          const p = this.pending.get(m.id);
          if (!p) return anomalies.push({ t: ts(), what: `reply for unknown rpc id ${m.id}` });
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          p.done(m);
        } else if (m.t === 'ev') {
          pushes++;
          bot.onEvent(m.ev, this);
        }
      });
      this.ws.on('close', (code) => {
        this.closed = code;
        closes.set(code, (closes.get(code) || 0) + 1);
        resolve(false);
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.done({ ok: false, code: 'CLOSED' });
        }
        this.pending.clear();
        bot.onClose(this, code);
      });
      this.ws.on('error', () => {});
    });
  }
  get open() {
    return this.ws.readyState === 1 && this.welcome;
  }
  // Resolves { ok, r, code } - never rejects. Unanswered after 20 s = anomaly.
  rpc(m, a = {}, { chaos = false } = {}) {
    if (!this.open) return Promise.resolve({ ok: false, code: 'OFFLINE' });
    return new Promise((resolve) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (!inFault()) anomalies.push({ t: ts(), what: `rpc ${m} never answered (20 s)` });
        resolve({ ok: false, code: 'NO_REPLY' });
      }, 20000);
      this.pending.set(id, {
        timer,
        done: (x) => {
          if (x.code !== 'CLOSED') note(m, x.ok ? null : x.code, chaos);
          resolve(x);
        },
      });
      this.ws.send(JSON.stringify({ t: 'rpc', id, m, a }));
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

// ---------------------------------------------------------------- the bots
const accounts = []; // { id, name, bot }
const WEIGHTS = [
  ['guest', 0.2],
  ['player', 0.25],
  ['trader', 0.15],
  ['social', 0.2],
  ['troll', 0.1],
  ['chaos', 0.1],
];
function pickPersona(i) {
  let x = (i * 0.6180339887) % 1; // deterministic spread
  for (const [p, w] of WEIGHTS) {
    if ((x -= w) < 0) return p;
  }
  return 'guest';
}

class Bot {
  constructor(i) {
    this.i = i;
    this.persona = pickPersona(i);
    this.decode = this.persona === 'player' || (this.persona === 'guest' && i % 10 === 0);
    this.name = `${RUN}_${this.persona.slice(0, 2)}${i}`;
    this.password = 'password123';
    this.items = [];
    this.trades = new Map();
    this.stopped = false;
  }

  async start(url) {
    this.url = url;
    this.c = new Conn(this, url, {});
    if (!(await this.c.ready)) return;
    if (this.persona === 'guest') return;
    // Register (with the proof of work, like the browser).
    const ch = await this.c.rpc('auth.challenge');
    const pow = ch.ok && ch.r.bits > 0 ? { challenge: ch.r.challenge, nonce: await powSolve(ch.r.challenge, ch.r.bits) } : undefined;
    const r = await this.c.rpc('auth.register', { name: this.name, password: this.password, pow });
    if (!r.ok) return;
    this.token = r.r.token;
    this.id = r.r.account.id;
    accounts.push({ id: this.id, name: this.name, bot: this });
    await this.reconnect();
  }

  async reconnect(url = this.url) {
    const old = this.c;
    const token = this.token;
    const conn = new Conn(this, url, token ? { session: token } : {});
    this.c = conn;
    const ok = await conn.ready;
    if (old && old !== conn) old.close();
    // A session can legitimately be gone by now (log out everywhere, ban).
    if (ok && token && token === this.token && !this.banned && !conn.welcome.account) anomalies.push({ t: ts(), what: `${this.persona}: valid session came back as guest` });
    if (ok && this.id && conn.welcome.account && conn.welcome.pid !== this.id) anomalies.push({ t: ts(), what: `${this.persona}: pid != account id` });
    if (conn !== this.c) return ok;
    this.view();
    return ok;
  }

  onClose(conn, code) {
    if (conn !== this.c || this.stopped) return;
    if (code === 4003) this.banned = true;
    if (code === 4005) this.token = null; // logged out everywhere: continue as guest
    if (![1000, 1005, 4001, 4003, 4004, 4005].includes(code) && !inFault()) anomalies.push({ t: ts(), what: `${this.persona} socket closed ${code}` });
    if (code !== 4003 && code !== 4004) setTimeout(() => !this.stopped && this.reconnect(), 1000 + Math.random() * 2000);
  }

  onEvent(ev, conn) {
    if (ev.type === 'friend' && ev.status === 'incoming' && chance(0.8)) conn.rpc('friends.respond', { from: ev.id, accept: chance(0.9) });
    if (ev.type === 'trade') {
      const t = ev.trade;
      this.trades.set(t.id, t);
      // Counterparty behaviour: sometimes add coins, then confirm what we saw.
      if (t.status === 'open' && (this.persona === 'trader' || this.persona === 'chaos')) {
        const mine = t.a === this.id ? 'a' : 'b';
        if (!t[`${mine}Ok`] && chance(0.5)) setTimeout(() => conn.rpc('trade.confirm', { id: t.id, version: t.version }), 200 + Math.random() * 800);
      }
    }
  }

  view() {
    if (!this.c.open) return;
    const w = this.c.welcome.world;
    const W = w.chunksX * w.chunkSize;
    const H = w.chunksY * w.chunkSize;
    this.vx = Math.random() * (W - 600);
    this.vy = Math.random() * (H - 400);
    this.c.ws.send(encodeView(this.vx, this.vy, this.vx + 600, this.vy + 400));
  }

  centre() {
    return [this.vx + 300, this.vy + 200];
  }

  async tick() {
    if (!this.c || !this.c.open || this.banned) return;
    const c = this.c;
    const p = this.persona;
    const [x, y] = this.centre();
    if (chance(0.1)) this.view();
    if (chance(0.3)) c.ws.send(encodeAction(rnd([ACTIONS.NUTRIENT, ACTIONS.SEED, ACTIONS.SIGNAL, ACTIONS.STIR]), x, y, 1, 0));
    if (p === 'guest') {
      if (chance(0.2)) c.ws.send(JSON.stringify({ t: 'chat', text: rnd(['hello', '有人吗', 'look at this lineage', 'gg']) }));
      if (chance(0.1)) await c.rpc('market.browse', {});
      if (chance(0.05)) await c.rpc('wallet.get'); // guests must get LOGIN_REQUIRED
      return;
    }
    const other = accounts.length > 1 ? rnd(accounts.filter((a) => a.id !== this.id)) : null;
    if (p === 'player') {
      if (chance(0.3)) c.ws.send(encodeAction(ACTIONS.SEED, x, y));
      if (chance(0.3) && c.world) {
        const mine = [...c.world.entities.values()].filter((e) => e.owner === this.id && e.kind === 1);
        if (mine.length) {
          const e = rnd(mine);
          await c.rpc('item.capture', { entityId: e.id, x: e.x, y: e.y });
        }
      }
      const w = await c.rpc('wallet.get');
      if (!w.ok) return;
      const free = w.r.items.filter((it) => !it.lock);
      if (free.length && chance(0.2)) await c.rpc('item.release', { item: rnd(free).id, x, y });
      if (free.length && chance(0.3)) await c.rpc('market.list', { item: rnd(free).id, price: 5 + Math.floor(Math.random() * 50) });
      if (chance(0.3)) {
        const b = await c.rpc('market.browse', {});
        const cand = b.ok ? b.r.filter((l) => l.seller !== this.id) : [];
        if (cand.length) await c.rpc('market.buy', { listing: rnd(cand).id });
      }
      if (chance(0.1)) {
        const mine = await c.rpc('market.mine');
        if (mine.ok && mine.r.length) await c.rpc('market.cancel', { listing: rnd(mine.r).id });
      }
      return;
    }
    if (p === 'trader') {
      if (other && chance(0.3)) await c.rpc('trade.open', { with: other.id });
      const mineT = await c.rpc('trade.mine');
      if (mineT.ok && mineT.r.length) {
        const t = rnd(mineT.r);
        if (chance(0.5)) {
          const w = await c.rpc('wallet.get');
          const free = w.ok ? w.r.items.filter((it) => !it.lock).map((it) => it.id) : [];
          const r = await c.rpc('trade.offer', { id: t.id, items: free.slice(0, Math.floor(Math.random() * 3)), coins: Math.floor(Math.random() * 30) });
          if (r.ok && chance(0.7)) await c.rpc('trade.confirm', { id: t.id, version: r.r.version });
        } else if (chance(0.5)) await c.rpc('trade.confirm', { id: t.id, version: t.version });
        else if (chance(0.2)) await c.rpc('trade.cancel', { id: t.id });
      }
      // Race: everyone tries the newest listing at once.
      if (chance(0.3)) {
        const b = await c.rpc('market.browse', {});
        if (b.ok && b.r.length && b.r[0].seller !== this.id) await c.rpc('market.buy', { listing: b.r[0].id });
      }
      return;
    }
    if (p === 'social') {
      if (other && chance(0.2)) await c.rpc('friends.request', { to: other.id });
      const fl = await c.rpc('friends.list');
      const friends = fl.ok ? fl.r.filter((f) => f.status === 'accepted') : [];
      if (friends.length && chance(0.6)) await c.rpc('dm.send', { to: rnd(friends).id, text: rnd(['嗨', 'how is your lineage?', '我的细胞分裂了', 'trade?']) });
      else if (other && chance(0.2)) await c.rpc('dm.send', { to: other.id, text: 'hi stranger' });
      if (chance(0.3)) {
        const u = await c.rpc('dm.unread');
        if (u.ok && u.r.length) {
          await c.rpc('dm.history', { with: u.r[0].id });
          await c.rpc('dm.read', { with: u.r[0].id });
        }
      }
      if (chance(0.05)) await c.rpc('auth.privacy', { dm: rnd(['everyone', 'friends', 'everyone']) });
      if (chance(0.03) && friends.length) await c.rpc('friends.remove', { id: rnd(friends).id });
      return;
    }
    if (p === 'troll') {
      c.ws.send(JSON.stringify({ t: 'chat', text: rnd(['free coins at scam.xyz/login', '加我微信 12345678', 'spam spam spam', 'spam spam spam', 'hello']) }));
      if (other && chance(0.4)) await c.rpc('dm.send', { to: other.id, text: rnd(['加v 99887766 便宜卖', 'visit cheap.top now', 'hey']) });
      if (other && chance(0.1)) await c.rpc('report.create', { target: other.id, reason: 'random report' });
      if (other && chance(0.05)) await c.rpc('block.add', { id: other.id });
      if (other && chance(0.1)) await c.rpc('friends.request', { to: other.id });
      return;
    }
    if (p === 'chaos') {
      const k = Math.floor(Math.random() * 12);
      if (k === 0) c.ws.send('{"t":"rpc", broken json');
      else if (k === 1) await c.rpc('admin.role', { id: this.id, role: 'admin' }, { chaos: true });
      else if (k === 2) await c.rpc('item.captured', { key: 'cap:fake:1', data: {} }, { chaos: true });
      else if (k === 3)
        await c.rpc(rnd(['market.buy', 'trade.confirm', 'dm.send', 'market.list', 'trade.offer']), rnd([{ listing: -1 }, { id: 'x', version: 1e308 }, { to: [1, 2], text: { a: 1 } }, { item: 2 ** 60, price: -5 }, { id: 1, items: new Array(50).fill(1), coins: 1e12 }]), { chaos: true });
      else if (k === 4) c.ws.send(Buffer.from([10, 1, 2, 3])); // malformed view
      else if (k === 5) {
        // Hang up in the middle of a request, come back.
        c.rpc('wallet.get');
        c.close();
      } else if (k === 6 && this.token) {
        // Second tab on the same session: the first is replaced (4004).
        const tab = new Conn(this, this.url, { session: this.token });
        await tab.ready;
        await sleep(500);
        tab.close();
      } else if (k === 7 && this.token && c.welcome.zones) {
        // Jump straight to a zone gateway.
        const z = rnd(c.welcome.zones.urls);
        const zurl = z.startsWith('ws') ? z : this.url.replace(/\/ws$/, z.replace(/^\/z\/\d+/, ''));
        await this.reconnect(zurl);
      } else if (k === 8 && this.token && chance(0.2)) {
        await c.rpc('auth.logoutAll');
        // Log back in with the password.
        const g = new Conn(this, this.url, {});
        if (await g.ready) {
          const r = await g.rpc('auth.login', { name: this.name, password: this.password });
          if (r.ok) this.token = r.r.token;
          g.close();
        }
        await this.reconnect();
      } else if (k === 9) await c.rpc('item.capture', { entityId: 1, x: -5, y: 1e9 }, { chaos: true });
      else if (k === 10) for (let j = 0; j < 30; j++) c.rpc('wallet.get'); // burst over the rate limit
      else if (other) await c.rpc('trade.open', { with: other.id });
    }
  }

  async run(until) {
    while (Date.now() < until && !this.stopped) {
      await sleep(500 + Math.random() * 2000);
      try {
        await this.tick();
      } catch (err) {
        anomalies.push({ t: ts(), what: `bot ${this.persona} threw: ${err.message}` });
      }
    }
  }

  stop() {
    this.stopped = true;
    this.c?.close();
  }
}

// ------------------------------------------------------------- moderator
async function admin(op, body) {
  const r = await fetch(`${HTTP}/admin/api/${op}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) anomalies.push({ t: ts(), what: `admin ${op} -> HTTP ${r.status} ${j.error || ''}` });
  return j;
}
async function moderator(until) {
  if (!ADMIN) return;
  while (Date.now() < until) {
    await sleep(5000);
    const trolls = accounts.filter((a) => a.bot.persona === 'troll');
    if (!trolls.length) continue;
    const t = rnd(trolls);
    await admin('meta/sanction', { id: t.id, muteMinutes: 1, reason: 'soak' });
    if (chance(0.3)) await admin('meta/sanction', { id: t.id, muteMinutes: 0 });
    if (chance(0.15)) await admin('meta/sanction', { id: t.id, banMinutes: 10, reason: 'soak ban' });
    await admin('meta/reports');
    await admin('meta/flows');
  }
}

// ------------------------------------------------------------- invariants
async function checkDb(url) {
  const { default: pg } = await import('pg');
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  const fails = [];
  const check = (cond, what) => {
    if (!cond) fails.push(what);
  };
  const [{ s }] = await q('SELECT coalesce(sum(amount), 0)::bigint AS s FROM balances');
  check(Number(s) === 0, `sum of all balances = ${s} (must be 0)`);
  const neg = await q('SELECT account, amount FROM balances WHERE account > 0 AND amount < 0');
  check(!neg.length, `negative balances: ${JSON.stringify(neg)}`);
  const flow = await q(`SELECT b.account, b.amount,
      coalesce((SELECT sum(amount) FROM ledger WHERE to_acct = b.account), 0) - coalesce((SELECT sum(amount) FROM ledger WHERE from_acct = b.account), 0) AS f
      FROM balances b`);
  const bad = flow.filter((r) => Number(r.f) !== Number(r.amount));
  check(!bad.length, `balance != ledger flow for ${bad.length} accounts`);
  const lockBad = await q(`SELECT i.id, i.lock FROM items i WHERE i.lock LIKE 'L:%' AND NOT EXISTS
      (SELECT 1 FROM listings l WHERE 'L:' || l.id = i.lock AND l.status = 'open' AND l.item = i.id AND l.seller = i.owner)`);
  check(!lockBad.length, `items locked by a listing that is not open/theirs: ${lockBad.length}`);
  const openBad = await q(`SELECT l.id FROM listings l JOIN items i ON i.id = l.item WHERE l.status = 'open' AND (i.lock IS DISTINCT FROM 'L:' || l.id OR i.owner <> l.seller OR i.state <> 'held')`);
  check(!openBad.length, `open listings whose item is not escrowed: ${openBad.length}`);
  const soldTwice = await q(`SELECT item, count(*) FROM listings WHERE status = 'sold' GROUP BY item, closed HAVING count(*) > 1`);
  check(!soldTwice.length, `an item sold twice in one moment: ${soldTwice.length}`);
  const hist = await q(`SELECT i.id FROM items i WHERE i.state = 'held' AND i.owner <> (SELECT to_acct FROM item_log g WHERE g.item = i.id ORDER BY g.id DESC LIMIT 1)`);
  check(!hist.length, `items whose owner differs from their last history entry: ${hist.length}`);
  const quota = await q(`SELECT to_acct, count(*) AS n FROM item_log WHERE action = 'create' GROUP BY to_acct HAVING count(*) > 50`);
  check(!quota.length, `accounts over the daily capture quota: ${JSON.stringify(quota)}`);
  const cap = await q(`SELECT to_acct, ref, sum(amount) AS s FROM ledger WHERE kind = 'reward' GROUP BY to_acct, ref HAVING sum(amount) > 3`);
  check(!cap.length, `reward cap exceeded: ${JSON.stringify(cap.slice(0, 3))}`);
  const bannedSess = await q(`SELECT count(*) AS n FROM sessions s JOIN accounts a ON a.id = s.account WHERE a.banned_until > $1`, [Date.now()]);
  check(Number(bannedSess[0].n) === 0, `banned accounts still have ${bannedSess[0].n} sessions`);
  const blockedFriends = await q(`SELECT count(*) AS n FROM friends f JOIN blocks b ON (b.account = f.a AND b.target = f.b) OR (b.account = f.b AND b.target = f.a)`);
  check(Number(blockedFriends[0].n) === 0, `blocked pairs still friends: ${blockedFriends[0].n}`);
  const stats = {
    accounts: (await q('SELECT count(*) AS n FROM accounts'))[0].n,
    items: (await q("SELECT count(*) AS n FROM items WHERE state = 'held'"))[0].n,
    consumed: (await q("SELECT count(*) AS n FROM items WHERE state <> 'held'"))[0].n,
    sold: (await q("SELECT count(*) AS n FROM listings WHERE status = 'sold'"))[0].n,
    tradesDone: (await q("SELECT count(*) AS n FROM trades WHERE status = 'done'"))[0].n,
    messages: (await q('SELECT count(*) AS n FROM messages'))[0].n,
    friendships: (await q("SELECT count(*) AS n FROM friends WHERE status = 'accepted'"))[0].n,
    reports: (await q('SELECT count(*) AS n FROM reports'))[0].n,
    rewards: (await q("SELECT count(*) AS n FROM ledger WHERE kind = 'reward'"))[0].n,
  };
  await db.end();
  return { fails, stats };
}

// ------------------------------------------------------------------- main
async function main() {
  console.log(`[soak] ${N} bots for ${SECONDS}s against ${URL0}`);
  const bots = Array.from({ length: N }, (_, i) => new Bot(i));
  const counts = {};
  for (const b of bots) counts[b.persona] = (counts[b.persona] || 0) + 1;
  console.log('[soak] personas', counts);
  // Ramp up: 50 every 500 ms.
  for (let k = 0; k < N; k += 50) {
    await Promise.all(bots.slice(k, k + 50).map((b) => b.start(URL0).catch((err) => anomalies.push({ t: ts(), what: `start: ${err.message}` }))));
  }
  console.log(`[soak] ${ts()}s: ${accounts.length} accounts registered, running`);
  const until = Date.now() + SECONDS * 1000;
  // Fault windows announced by the harness on stdin ("fault <seconds>").
  process.stdin.on('data', (d) => {
    const m = String(d).match(/fault (\d+)/);
    if (m) {
      const now = Date.now() - t0;
      faults.push([now, now + Number(m[1]) * 1000]);
      console.log(`[soak] ${ts()}s fault window ${m[1]}s`);
    }
  });
  const progress = setInterval(() => {
    let calls = 0;
    for (const o of ops.values()) calls += o.ok;
    console.log(`[soak] t=${ts()}s ok calls=${calls} pushes=${pushes} anomalies=${anomalies.length}`);
  }, 15000);
  await Promise.all([...bots.map((b) => b.run(until)), moderator(until)]);
  clearInterval(progress);
  await sleep(3000); // let in-flight calls finish
  // World replicas: every decoder must be consistent.
  let unknownIds = 0;
  let dupAdds = 0;
  for (const w of decoded) {
    unknownIds += w.stats.unknownIds;
    dupAdds += w.stats.dupAdds;
  }
  for (const b of bots) b.stop();

  console.log('\n===== RPC results (ok / error codes) =====');
  for (const [m, o] of [...ops].sort()) console.log(`${m.padEnd(20)} ok=${String(o.ok).padStart(6)}  ${[...o.codes].map(([c, n]) => `${c}=${n}`).join(' ')}`);
  console.log('\n===== socket close codes =====', Object.fromEntries(closes));
  console.log(`===== world replicas: ${decoded.length} decoders, unknownIds=${unknownIds}, dupAdds=${dupAdds}`);
  for (const e of worldEvents.slice(0, 40)) console.log('  world:', e);
  if (unknownIds || dupAdds) anomalies.push({ t: ts(), what: `world replica inconsistencies: unknownIds=${unknownIds} dupAdds=${dupAdds}` });
  if (args.db) {
    const { fails, stats } = await checkDb(args.db);
    console.log('===== database =====', stats);
    for (const f of fails) anomalies.push({ t: ts(), what: `DB invariant: ${f}` });
    console.log(fails.length ? `DB invariants FAILED: ${fails.length}` : 'DB invariants: all hold');
  }
  console.log(`\n===== anomalies: ${anomalies.length} =====`);
  const grouped = new Map();
  for (const a of anomalies) {
    const g = grouped.get(a.what) || { n: 0, first: a.t };
    g.n++;
    grouped.set(a.what, g);
  }
  for (const [what, g] of grouped) console.log(`  ${g.n}x  ${what}  (first at ${g.first}s)`);
  process.exit(anomalies.length ? 1 : 0);
}
main().catch((err) => {
  console.error(err);
  process.exit(2);
});

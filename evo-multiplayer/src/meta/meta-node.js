// Meta service: accounts, economy, social, moderation - everything that must
// be durable or must follow a player across zones. Separate from the world
// simulation (shards) on purpose: different consistency needs.
//
//   node src/meta/meta-node.js      (env: META_ID, META_URLS, DATABASE_URL, CLUSTER_SECRET)
//
// Run several replicas against one PostgreSQL. Each account has a home
// replica (id % replicas) holding its live presence and delivering its
// events; any replica can serve any request because state lives in the DB.
// Replicas form a mesh to forward deliveries and share who is online.
// Gateways connect to every replica and route each request to the caller's
// home replica (so per-account rate limits are consistent).

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Link, readClusterConfig } from '../server/link.js';
import { openStore } from './store.js';
import { Accounts } from './accounts.js';
import { Economy } from './economy.js';
import { Social } from './social.js';
import { Moderator, loadBlocklist } from './moderation.js';
import { AppError } from './ledger.js';
import { CLIENT_METHODS, homeReplica } from './methods.js';

export { CLIENT_METHODS };

// The database may come up after us (container start order, failover):
// wait for it instead of crashing, for up to DB_WAIT seconds.
async function openStoreWithRetry(url, log, waitS = Number(process.env.DB_WAIT || 120)) {
  const t0 = Date.now();
  for (let delay = 500; ; delay = Math.min(5000, delay * 2)) {
    try {
      return await openStore(url);
    } catch (err) {
      if (Date.now() - t0 > waitS * 1000 || !/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|starting up|57P03|ECONNRESET/.test(`${err.code} ${err.message}`)) throw err;
      log(`database not reachable yet (${err.code || err.message}); retrying`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export async function startMeta(opts = {}) {
  const cfg = readClusterConfig();
  const id = Number(opts.id ?? cfg.get('meta-id', 'META_ID', 0));
  const urls = opts.urls ?? JSON.parse(cfg.get('meta-urls', 'META_URLS', '["ws://127.0.0.1:9300"]'));
  const port = Number(opts.port ?? cfg.get('port', 'PORT', new URL(urls[id]).port || 9300));
  const host = opts.host ?? cfg.get('host', 'HOST', '127.0.0.1');
  const secret = opts.secret ?? cfg.secret;
  const dbUrl = opts.database ?? cfg.get('database-url', 'DATABASE_URL', 'sqlite:data/meta.db');
  const quiet = opts.quiet ?? cfg.get('quiet', 'QUIET', '') === 'true';
  const log = (...a) => {
    if (!quiet) console.log(`[meta ${id}]`, ...a);
  };
  const M = urls.length;
  // Most coins one account can earn from its living lineage per period,
  // summed over every shard.
  const rewardCap = Number(opts.rewardCap ?? cfg.get('reward-cap', 'REWARD_CAP', 3));
  const home = (acct) => homeReplica(acct, M);

  const store = opts.store ?? (await openStoreWithRetry(dbUrl, log));
  const accounts = new Accounts(store, {
    log,
    registerPerHour: Number(opts.registerPerHour ?? cfg.get('register-per-hour', 'REGISTER_PER_IP_HOUR', 5)),
    pepper: secret, // IPs are stored only as keyed hashes
  });
  const social = new Social(store);
  const economy = new Economy(store, {
    notify: (acct, ev) => {
      if (ev.type !== 'trade') return deliver(acct, ev);
      enrichTrade(ev.trade)
        .then((trade) => deliver(acct, { ...ev, trade }))
        .catch(() => deliver(acct, ev));
    },
  });
  // Trade views with names and item details, so clients can show exactly
  // what is on the table.
  async function enrichTrade(v) {
    const ids = [...v.aItems, ...v.bItems];
    const names = await store.query('SELECT id, display FROM accounts WHERE id = $1 OR id = $2', [v.a, v.b]);
    const nameOf = Object.fromEntries(names.rows.map((r) => [Number(r.id), r.display]));
    const items = {};
    for (const id of ids) {
      const r = await store.query('SELECT id, kind, data FROM items WHERE id = $1', [id]);
      if (r.rows[0]) items[id] = { id, kind: r.rows[0].kind, data: JSON.parse(r.rows[0].data) };
    }
    return { ...v, aName: nameOf[v.a], bName: nameOf[v.b], items };
  }
  const moderator = new Moderator({
    blocklist: loadBlocklist(opts.blocklist ?? cfg.get('blocklist', 'BLOCKLIST', '')),
    allowDomains: String(opts.allowDomains ?? cfg.get('allow-domains', 'ALLOW_DOMAINS', '')).split(',').filter(Boolean),
    onAutoMute: (acct, until, reasons) => autoMute(acct, until, reasons),
  });
  log(`store ${store.kind}, replica ${id + 1}/${M}`);

  // ------------------------------------------------------------ presence
  const conns = new Map(); // acct -> Set(connKey)   (home replica only)
  const connSock = new Map(); // connKey -> { ws, conn }
  const gwConns = new Map(); // gateway ws -> Set(connKey)
  const online = new Set(); // every online account (shared by gossip)
  const peers = new Map(); // replica -> Link

  for (let r = 0; r < M; r++) {
    if (r === id) continue;
    peers.set(
      r,
      new Link(urls[r], { t: 'hello', role: 'meta', id, secret }, {
        log,
        onOpen: (l) => {
          // Re-announce our online accounts (a restarted peer lost them).
          const mine = [...conns.keys()];
          for (let k = 0; k < mine.length; k += 5000) l.send(JSON.stringify({ t: 'presence', accts: mine.slice(k, k + 5000), online: true }));
        },
        // A dead peer can't send "offline" for its accounts: forget them
        // until it is back (it re-announces who is really online).
        onClose: () => {
          for (const a of [...online]) if (home(a) === r) online.delete(a);
        },
      }),
    );
  }

  function broadcastPeers(msg) {
    const text = JSON.stringify(msg);
    for (const l of peers.values()) l.send(text);
  }

  async function setOnline(acct, on) {
    if (closing || on === online.has(acct)) return;
    if (on) online.add(acct);
    else online.delete(acct);
    broadcastPeers({ t: 'presence', accts: [acct], online: on });
    // Tell friends (their home replicas deliver).
    try {
      const a = await accounts.get(acct);
      for (const f of await social.friendIds(acct)) deliver(f, { type: 'presence', id: acct, name: a?.name, online: on });
    } catch (err) {
      log('presence notify failed', err.message);
    }
  }

  function connOnline(ws, acct, conn) {
    const key = `${gwOf(ws)}:${conn}`;
    connSock.set(key, { ws, conn });
    let set = conns.get(acct);
    if (!set) conns.set(acct, (set = new Set()));
    set.add(key);
    let g = gwConns.get(ws);
    if (!g) gwConns.set(ws, (g = new Set()));
    g.add(key);
    connAcct.set(key, acct);
    if (set.size === 1) setOnline(acct, true);
  }

  function connOffline(key) {
    const acct = connAcct.get(key);
    connAcct.delete(key);
    const s = connSock.get(key);
    connSock.delete(key);
    if (s) gwConns.get(s.ws)?.delete(key);
    if (acct === undefined) return;
    const set = conns.get(acct);
    if (!set) return;
    set.delete(key);
    if (set.size === 0) {
      conns.delete(acct);
      setOnline(acct, false);
    }
  }
  const connAcct = new Map();
  const gwIds = new Map();
  const gwOf = (ws) => gwIds.get(ws) ?? '?';

  // Replies and pushes produced in the same event-loop turn go to a gateway
  // as one frame (one syscall) instead of one each: under load most of this
  // process's CPU was spent in socket writes. Order per socket is kept.
  const outQ = new Map(); // ws -> [msg]
  let outScheduled = false;
  function sendBatched(ws, msg) {
    let q = outQ.get(ws);
    if (!q) outQ.set(ws, (q = []));
    q.push(msg);
    if (!outScheduled) {
      outScheduled = true;
      setImmediate(flushOut);
    }
  }
  function flushOut() {
    outScheduled = false;
    for (const [ws, q] of outQ) if (ws.readyState === 1) ws.send(JSON.stringify(q.length === 1 ? q[0] : q));
    outQ.clear();
  }

  // Deliver a live event to every session of `acct` (wherever it is).
  function deliver(acct, ev) {
    // A sanction set on another replica: the home replica must not keep
    // serving the cached (unmuted) account.
    if (ev.type === 'muted' || ev.type === 'banned' || ev.type === 'unmuted') accounts.invalidate(acct);
    const h = home(acct);
    if (h !== id) {
      peers.get(h)?.send(JSON.stringify({ t: 'deliver', acct, ev }));
      return;
    }
    for (const key of conns.get(acct) || []) {
      const s = connSock.get(key);
      if (s && s.ws.readyState === 1) sendBatched(s.ws, { t: 'push', conn: s.conn, ev });
    }
  }

  // Sessions of `acct` were revoked (password change, "log out everywhere",
  // recovery): gateways re-check every open connection of that account and
  // close those whose session is gone - otherwise a hijacker's open socket
  // would keep trading after the owner secured the account.
  function sessionsChanged(acct) {
    deliver(acct, { type: 'sessions-changed' });
  }

  async function autoMute(acct, until, reasons) {
    await accounts.setSanction(acct, { mutedUntil: until });
    await social.audit(0, 'auto-mute', `acct:${acct}`, { until, reasons });
    deliver(acct, { type: 'muted', until, reason: '自动禁言：多次发送违规内容' });
    log(`auto-muted ${acct} until ${new Date(until).toISOString()} (${reasons})`);
  }

  // ------------------------------------------------------------- methods
  const need = (acct) => {
    if (!acct) throw new AppError('LOGIN_REQUIRED', '请先登录');
    return acct;
  };

  async function requireRole(acct, roles, superuser) {
    if (superuser) return { id: 0, role: 'admin' };
    const a = acct && (await accounts.get(acct));
    if (!a || !roles.includes(a.role)) throw new AppError('FORBIDDEN', '没有权限');
    return a;
  }

  async function dmSend(acct, to, text) {
    const me = await accounts.get(acct);
    to = Number(to);
    if (!Number.isSafeInteger(to) || to <= 0) throw new AppError('BAD_ARG', '收信人无效');
    const { friends } = await social.canMessage(acct, to, me.mutedUntil);
    const mod = moderator.check(String(text ?? '').slice(0, 500), { account: acct, channel: 'dm', toFriend: friends });
    if (!mod.ok) throw new AppError('MODERATED', `消息未发送（${mod.reasons.join('、')}）`);
    const msg = await social.storeMessage(acct, to, mod.text, mod.reasons.join(','));
    const ev = { type: 'dm', msg, fromName: me.name };
    deliver(to, ev);
    deliver(acct, ev); // the sender's other tabs/devices
    return msg;
  }

  const methods = {
    'auth.register': (a, x) => accounts.register({ name: a.name, password: a.password, hue: a.hue, ua: x.ua, ip: x.ip }),
    'auth.login': (a, x) => accounts.login({ name: a.name, password: a.password, totp: a.totp, ua: x.ua, ip: x.ip }),
    'auth.recover': async (a, x) => {
      const r = await accounts.recover({ name: a.name, code: a.code, newPassword: a.newPassword, ua: x.ua, ip: x.ip });
      accounts.invalidate(r.account.id);
      sessionsChanged(r.account.id);
      return r;
    },
    'auth.resume': (a) => accounts.resume(a.token),
    'auth.logout': (a) => accounts.logout(a.token),
    'auth.logoutAll': async (a, x) => {
      await accounts.logoutAll(need(x.acct));
      sessionsChanged(x.acct);
    },
    'auth.sessions': (a, x) => accounts.sessions(need(x.acct)),
    'auth.password': async (a, x) => {
      await accounts.changePassword(need(x.acct), a.old, a.new);
      sessionsChanged(x.acct);
    },
    'auth.totpSetup': (a, x) => accounts.totpSetup(need(x.acct)),
    'auth.totpEnable': (a, x) => accounts.totpEnable(need(x.acct), a.code),
    'auth.totpDisable': (a, x) => accounts.totpDisable(need(x.acct), a.code),
    'auth.privacy': (a, x) => accounts.setPrivacy(need(x.acct), a.dm),
    'auth.me': (a, x) => accounts.get(need(x.acct)),

    'wallet.get': (a, x) => economy.wallet(need(x.acct)),
    'market.browse': (a) => economy.browse({ maxPrice: a.maxPrice, page: a.page }),
    'market.list': (a, x) => economy.list(need(x.acct), a.item, a.price),
    'market.cancel': (a, x) => economy.cancelListing(need(x.acct), a.listing),
    'market.buy': (a, x) => economy.buy(need(x.acct), a.listing),
    'market.mine': (a, x) => economy.myListings(need(x.acct)),

    'trade.open': async (a, x) => {
      const other = a.with ?? (await accounts.byName(a.name))?.id;
      if (!other) throw new AppError('NOT_FOUND', '没有这个玩家');
      return enrichTrade(await economy.openTrade(need(x.acct), other, (p, q) => social.isBlocked(p, q)));
    },
    'trade.get': async (a, x) => enrichTrade(await economy.getTrade(need(x.acct), a.id)),
    'trade.mine': async (a, x) => Promise.all((await economy.myTrades(need(x.acct))).map(enrichTrade)),
    'trade.offer': async (a, x) => enrichTrade(await economy.setOffer(need(x.acct), a.id, { items: a.items, coins: a.coins })),
    'trade.confirm': async (a, x) => enrichTrade(await economy.confirm(need(x.acct), a.id, a.version)),
    'trade.cancel': async (a, x) => enrichTrade(await economy.cancelTrade(need(x.acct), a.id)),

    'friends.list': async (a, x) => (await social.list(need(x.acct))).map((f) => ({ ...f, online: online.has(f.id) })),
    'friends.request': async (a, x) => {
      const me = need(x.acct);
      const to = a.to ?? (await accounts.byName(a.name))?.id;
      if (!to) throw new AppError('NOT_FOUND', '没有这个玩家');
      const r = await social.request(me, Number(to));
      if (r.changed) {
        const meAcct = await accounts.get(me);
        deliver(Number(to), { type: 'friend', id: me, name: meAcct?.name, status: r.status === 'accepted' ? 'accepted' : 'incoming', online: true });
      }
      return { ...r, id: Number(to) };
    },
    'friends.respond': async (a, x) => {
      const me = need(x.acct);
      const r = await social.respond(me, a.from, !!a.accept);
      if (r.status === 'accepted') {
        const meAcct = await accounts.get(me);
        deliver(Number(a.from), { type: 'friend', id: me, name: meAcct?.name, status: 'accepted', online: true });
      }
      return r;
    },
    'friends.remove': (a, x) => social.remove(need(x.acct), a.id),
    'block.add': (a, x) => social.block(need(x.acct), a.id),
    'block.remove': (a, x) => social.unblock(need(x.acct), a.id),
    'block.list': (a, x) => social.blocks(need(x.acct)),
    'dm.send': (a, x) => dmSend(need(x.acct), a.to, a.text),
    'dm.history': (a, x) => social.history(need(x.acct), a.with, a.before),
    'dm.unread': (a, x) => social.unread(need(x.acct)),
    'dm.read': (a, x) => social.markRead(need(x.acct), a.with),
    'player.find': async (a) => {
      const p = await accounts.byName(a.name);
      // Online status is only shown to friends (friends.list), not to anyone.
      return p ? { id: p.id, name: p.name } : null;
    },
    'report.create': (a, x) => social.report(need(x.acct), a.target, a.reason),

    // Gateway-internal (never reachable from a client: not in CLIENT_METHODS).
    'item.captureAllowed': (a, x) => economy.captureAllowed(need(x.acct)),
    'item.captured': (a, x) => economy.captured(need(x.acct), a.key, a.data),
    'item.release': (a, x) => economy.release(need(x.acct), a.item),
    'mod.autoMute': (a) => autoMute(Number(a.acct), Number(a.until), a.reasons),

    // Staff (role checked here, not only at the gateway).
    'admin.reports': async (a, x) => (await requireRole(x.acct, ['mod', 'admin'], x.superuser)) && social.reports(a.status || 'open'),
    'admin.closeReport': async (a, x) => {
      const who = await requireRole(x.acct, ['mod', 'admin'], x.superuser);
      await social.closeReport(a.id, who.id, a.note);
      await social.audit(who.id, 'close-report', `report:${a.id}`, a.note || '');
    },
    'admin.account': async (a, x) => {
      await requireRole(x.acct, ['mod', 'admin'], x.superuser);
      const acct = a.id ? await accounts.get(Number(a.id)) : await accounts.byName(a.name);
      if (!acct) throw new AppError('NOT_FOUND', '没有这个账号');
      return { account: acct, online: online.has(acct.id), wallet: await economy.wallet(acct.id), sessions: (await accounts.sessions(acct.id)).length };
    },
    'admin.sanction': async (a, x) => {
      const who = await requireRole(x.acct, ['mod', 'admin'], x.superuser);
      const target = Number(a.id);
      const now = Date.now();
      const s = {};
      if (a.muteMinutes !== undefined) s.mutedUntil = a.muteMinutes > 0 ? now + a.muteMinutes * 60000 : 0;
      if (a.banMinutes !== undefined) {
        if (who.role !== 'admin') throw new AppError('FORBIDDEN', '只有管理员能封号');
        s.bannedUntil = a.banMinutes > 0 ? now + a.banMinutes * 60000 : 0;
      }
      await accounts.setSanction(target, s);
      await social.audit(who.id, 'sanction', `acct:${target}`, { ...s, reason: a.reason || '' });
      if (s.mutedUntil) deliver(target, { type: 'muted', until: s.mutedUntil, reason: a.reason || '' });
      else if (s.mutedUntil === 0) deliver(target, { type: 'unmuted' });
      if (s.bannedUntil) deliver(target, { type: 'banned', until: s.bannedUntil });
      return s;
    },
    'admin.role': async (a, x) => {
      const who = await requireRole(x.acct, ['admin'], x.superuser);
      await accounts.setRole(Number(a.id), a.role);
      await social.audit(who.id, 'set-role', `acct:${a.id}`, a.role);
    },
    'admin.audit': async (a, x) => (await requireRole(x.acct, ['mod', 'admin'], x.superuser)) && social.auditLog(),
    'admin.flows': async (a, x) => (await requireRole(x.acct, ['mod', 'admin'], x.superuser)) && economy.flows({ hours: a.hours }),
    'admin.economy': async (a, x) => {
      await requireRole(x.acct, ['mod', 'admin'], x.superuser);
      const peersUp = [...peers.values()].filter((l) => l.open).length;
      return { ...(await economy.stats()), accountsOnline: online.size, replicas: M, replicasUp: peersUp + 1 };
    },
    // Gateways record world-side staff actions (bans, kicks, moves) here.
    'admin.note': async (a, x) => {
      const who = await requireRole(x.acct, ['mod', 'admin'], x.superuser);
      await social.audit(who.id, String(a.action || '').slice(0, 40), String(a.target || '').slice(0, 80), a.detail ?? '');
    },
  };

  let closing = false;
  let inflight = 0;
  async function handleRpc(ws, msg) {
    if (closing) return;
    inflight++;
    try {
      await handleRpcInner(ws, msg);
    } finally {
      inflight--;
    }
  }
  async function handleRpcInner(ws, msg) {
    const reply = (body) => {
      sendBatched(ws, { t: 'rpcr', id: msg.id, ...body });
    };
    const fn = methods[msg.m];
    if (!fn) return reply({ ok: false, code: 'NO_METHOD', msg: `unknown method ${msg.m}` });
    try {
      const r = await fn(msg.a || {}, { acct: Number(msg.acct) || 0, ip: msg.ip || '', ua: msg.ua || '', superuser: !!msg.superuser });
      reply({ ok: true, r: r ?? null });
    } catch (err) {
      if (err instanceof AppError) reply({ ok: false, code: err.code, msg: err.message });
      else if (/^22/.test(String(err.code || ''))) {
        // Postgres "data exception" (bad number, out of range...): the
        // client sent garbage that slipped past validation - its fault, not
        // a server error.
        log(`rpc ${msg.m}: rejected bad input (${err.message})`);
        reply({ ok: false, code: 'BAD_ARG', msg: '参数无效' });
      } else {
        log(`rpc ${msg.m} failed:`, err.message);
        reply({ ok: false, code: 'INTERNAL', msg: '服务器错误' });
      }
    }
  }

  // --------------------------------------------------------- housekeeping
  // Every replica runs it (staggered); the deletes are idempotent and in
  // small batches so a big table is never locked for long.
  const retentionDays = Number(opts.messageRetentionDays ?? cfg.get('message-retention-days', 'MESSAGE_RETENTION_DAYS', 365));
  async function deleteBatched(table, where, params) {
    let total = 0;
    for (;;) {
      const r = await store.query(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${where} LIMIT 2000)`, params);
      total += r.count;
      if (r.count < 2000) return total;
    }
  }
  async function housekeep(now = Date.now()) {
    const out = {};
    out.sessions = (await store.query('DELETE FROM sessions WHERE expires < $1', [now])).count;
    out.throttle = (await store.query('DELETE FROM throttle WHERE t < $1', [now - 3600000])).count;
    // Trades nobody touched for 3 days are cancelled (and both sides told).
    const stale = await store.query("UPDATE trades SET status = 'cancelled', updated = $1 WHERE status = 'open' AND updated < $2 RETURNING *", [now, now - 3 * 86400000]);
    out.trades = stale.rows.length;
    for (const row of stale.rows) economy.notifyTrade(economy.tradeView(row));
    out.messages = retentionDays > 0 ? await deleteBatched('messages', 'at < $1', [now - retentionDays * 86400000]) : 0;
    if (out.sessions || out.messages) log(`housekeeping: ${out.sessions} expired sessions, ${out.messages} old messages removed`);
    return out;
  }
  const housekeepTimer = setInterval(
    () => housekeep().catch((err) => log('housekeeping failed', err.message)),
    10 * 60000 + id * 37000,
  );
  housekeepTimer.unref();

  // ------------------------------------------------------------ transport
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') return res.end('ok');
    if (req.url === '/metrics') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ meta: id, replicas: M, store: store.kind, online: online.size, homeOnline: conns.size, gateways: gwConns.size }));
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: 4 * 1024 * 1024 });
  wss.on('connection', (ws) => {
    let role = null;
    // A frame carries one message or an array of them (see sendBatched).
    const onMsg = (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (role === null) {
        if (msg.t !== 'hello' || msg.secret !== secret) return ws.close(1008, 'bad hello');
        role = msg.role;
        if (role === 'gateway') {
          gwIds.set(ws, String(msg.id));
          gwConns.set(ws, new Set());
        }
        return;
      }
      if (role === 'gateway') {
        if (msg.t === 'rpc') handleRpc(ws, msg);
        else if (msg.t === 'online') connOnline(ws, Number(msg.acct), msg.conn);
        else if (msg.t === 'offline') connOffline(`${gwOf(ws)}:${msg.conn}`);
      } else if (role === 'meta') {
        if (msg.t === 'deliver') deliver(Number(msg.acct), msg.ev);
        else if (msg.t === 'presence') for (const a of msg.accts) msg.online ? online.add(a) : online.delete(a);
      } else if (role === 'shard') {
        if (msg.t === 'reward' && typeof msg.key === 'string' && !closing) {
          economy.reward(msg.entries || [], msg.key, { period: String(msg.period || msg.key), cap: rewardCap }).catch((err) => log('reward failed', err.message));
        }
      }
    };
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (Array.isArray(msg)) {
        if (role !== null) for (const m of msg) onMsg(m);
      } else onMsg(msg);
    });
    ws.on('close', () => {
      if (role === 'gateway') {
        for (const key of [...(gwConns.get(ws) || [])]) connOffline(key);
        gwConns.delete(ws);
        gwIds.delete(ws);
      }
    });
    ws.on('error', () => {});
  });
  await new Promise((r) => server.listen(port, host, r));
  log(`listening on ${host}:${port}`);

  return {
    port,
    store,
    accounts,
    economy,
    social,
    online,
    housekeep,
    // Stop taking work, let what is running finish, then close the DB (the
    // other way round, every disconnect during shutdown hit a closed pool).
    async close() {
      closing = true;
      clearInterval(housekeepTimer);
      for (const l of peers.values()) l.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close();
      const t = Date.now();
      while (inflight > 0 && Date.now() - t < 5000) await new Promise((r) => setTimeout(r, 20));
      if (!opts.store) await store.close();
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startMeta()
    .then((m) => {
      const stop = () => m.close().finally(() => process.exit(0));
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

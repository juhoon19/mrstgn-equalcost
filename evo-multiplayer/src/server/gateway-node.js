// Gateway node: the only thing exposed to the internet.
//
//   node src/server/gateway-node.js --port 8080 --topology '<json>'
//
// Responsibilities (how every large-audience realtime system splits it:
// shards own state, edge servers own sockets):
//  * serve the web client and accept player WebSockets;
//  * interest management: subscribe each client only to chunks in its view,
//    and subscribe the gateway to a chunk once no matter how many of its
//    clients watch it (refcounted), so shards never see the audience size;
//  * forward shard-encoded frames byte-for-byte to every watcher;
//  * per-client backpressure: a slow client is resynced from a keyframe
//    instead of letting its socket buffer grow without bound;
//  * input hygiene: rate limits, cooldowns, validation, then route each
//    action to the shard that owns the point.
//
// Gateways are stateless apart from connections: run as many as needed
// behind any TCP/HTTP load balancer, no sticky sessions required.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Topology, POS_QUANT } from '../shared/topology.js';
import { Reader, Writer } from '../shared/codec.js';
import {
  PROTOCOL_VERSION,
  S_CHUNK,
  S_FIELD,
  S_EVENTS,
  S_SUMMARY,
  S_PONG,
  C_VIEW,
  C_ACTION,
  C_CURSOR,
  C_PING,
  I_ACTIONS,
  I_CURSORS,
  I_SUMMARY,
  S_BATCH,
  F_KEY,
  F_LO,
  packBatch,
  unpackBatch,
  ACTION_COOLDOWN_MS,
  peekChunkHeader,
} from '../shared/protocol.js';
import { hueToRgb } from '../shared/color.js';
import { Link, readClusterConfig } from './link.js';
import { MetaClient, MetaError } from '../meta/meta-client.js';
import { CLIENT_METHODS, ADMIN_METHODS, GUEST_PID_MIN } from '../meta/methods.js';
import { Moderator } from '../meta/moderation.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function cleanText(s, max) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .trim()
    .slice(0, max);
}

export async function startGateway(opts = {}) {
  const cfg = readClusterConfig();
  const topoCfg = opts.topology ?? cfg.topology;
  const port = Number(opts.port ?? cfg.get('port', 'PORT', 8080));
  const host = opts.host ?? cfg.get('host', 'HOST', '0.0.0.0');
  const secret = opts.secret ?? cfg.secret;
  const tokenSecret = opts.tokenSecret ?? cfg.get('token-secret', 'TOKEN_SECRET', secret + ':tokens');
  const maxChunks = Number(opts.maxChunks ?? cfg.get('max-chunks', 'MAX_CHUNKS', 30));
  // ZONES: {"cols":2,"rows":2,"urls":["/z/0/ws",...]} (relative or absolute);
  // ZONE: which zone this gateway serves (-1 = lobby/any: hand everyone off).
  const zonesJson = opts.zones ?? cfg.get('zones', 'ZONES', '');
  const zones = typeof zonesJson === 'string' ? (zonesJson ? JSON.parse(zonesJson) : null) : zonesJson;
  const myZone = Number(opts.zone ?? cfg.get('zone', 'ZONE', -1));
  if (zones && (!Array.isArray(zones.urls) || zones.urls.length !== zones.cols * zones.rows)) {
    throw new Error('ZONES needs cols, rows and one url per zone');
  }
  const summaryMax = Number(opts.summaryMax ?? cfg.get('summary-max', 'SUMMARY_MAX', 48));
  const maxChunksLo = Number(opts.maxChunksLo ?? cfg.get('max-chunks-lo', 'MAX_CHUNKS_LO', 80));
  const viewMargin = Number(opts.viewMargin ?? cfg.get('view-margin', 'VIEW_MARGIN', 96));
  const maxPerIp = Number(opts.maxPerIp ?? cfg.get('max-per-ip', 'MAX_PER_IP', 16));
  const maxClients = Number(opts.maxClients ?? cfg.get('max-clients', 'MAX_CLIENTS', 20000));
  const trustProxy = (opts.trustProxy ?? cfg.get('trust-proxy', 'TRUST_PROXY', '')) === 'true' || opts.trustProxy === true;
  const adminToken = String(opts.adminToken ?? cfg.get('admin-token', 'ADMIN_TOKEN', ''));
  const blocklistFile = String(opts.blocklist ?? cfg.get('blocklist', 'BLOCKLIST', ''));
  const ipHeader = String(opts.ipHeader ?? cfg.get('ip-header', 'IP_HEADER', '')).toLowerCase();
  const proxyHops = Math.max(1, Number(opts.proxyHops ?? cfg.get('proxy-hops', 'PROXY_HOPS', 1)));
  const origins = String(opts.origins ?? cfg.get('origins', 'ALLOWED_ORIGINS', ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const highWater = Number(opts.highWater ?? cfg.get('high-water', 'HIGH_WATER', 512 * 1024));
  const REPLAY_RATE = Number(opts.replayRate ?? cfg.get('replay-rate', 'REPLAY_RATE', 256 * 1024)); // bytes/s
  const REPLAY_BURST = Number(opts.replayBurst ?? cfg.get('replay-burst', 'REPLAY_BURST', 2 * 1024 * 1024));
  const netHz = Number(opts.netHz ?? cfg.get('net-hz', 'NET_HZ', 10));
  const quiet = opts.quiet ?? cfg.get('quiet', 'QUIET', '') === 'true';
  const gwId = opts.id ?? crypto.randomBytes(4).toString('hex');
  const log = (...a) => {
    if (!quiet) console.log(`[gateway ${gwId}]`, ...a);
  };

  const topo = new Topology(topoCfg.world || {}, topoCfg.shards.length);
  const world = topo.world;

  // ------------------------------------------------------------- tokens
  // Stateless signed identity so a player keeps their id (and lineage) when
  // reconnecting to any gateway. Not an account system: anyone can mint a
  // fresh anonymous identity, but nobody can take over someone else's.
  function sign(pid) {
    return crypto.createHmac('sha256', tokenSecret).update(String(pid)).digest('base64url').slice(0, 22);
  }
  function makeToken(pid) {
    return `${pid}.${sign(pid)}`;
  }
  function readToken(token) {
    if (typeof token !== 'string') return 0;
    const [p, sig] = token.split('.');
    const pid = Number(p);
    if (!Number.isInteger(pid) || pid < GUEST_PID_MIN || pid >= 2 ** 31 || typeof sig !== 'string') return 0;
    const good = sign(pid);
    if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return 0;
    return pid;
  }

  // ------------------------------------------------------------- shards
  const shardLinks = [];
  const pendingSub = topoCfg.shards.map(() => new Set());
  const pendingUnsub = topoCfg.shards.map(() => new Set());
  const actionBatch = topoCfg.shards.map(() => []);
  const cursorBatch = topoCfg.shards.map(() => new Map());
  const lbByShard = new Map();
  const summary = {
    pop: new Uint16Array(topo.chunkCount),
    rgb: new Uint32Array(topo.chunkCount),
    nutrient: new Uint8Array(topo.chunkCount),
  };

  // Streams are keyed by k = chunkId * 2 + tier (tier 0 = 10 Hz, 1 = 2.5 Hz).
  // A client watches each chunk at exactly one tier.
  const chunkState = new Map(); // k -> { clients: Set, cache: Buffer[], unsubAt }
  const skey = (id, tier) => id * 2 + tier;
  const clients = new Set();
  const players = new Map(); // pid -> client (this gateway only)
  const perIp = new Map();
  const counters = { bytesIn: 0, bytesOut: 0, msgsOut: 0, framesIn: 0, resyncs: 0, dropped: 0, actions: 0 };

  topoCfg.shards.forEach((url, i) => {
    const link = new Link(
      url,
      { t: 'hello', role: 'gateway', id: gwId, secret },
      {
        log,
        onOpen: () => {
          // Re-establish everything the shard forgot (it may have restarted).
          const subs = [[], []];
          for (const [k, st] of chunkState) {
            const id = k >> 1;
            if (topo.ownerOf(id) !== i) continue;
            subs[k & 1].push(id);
            st.cache = [];
            for (const c of st.clients) c.chunks.set(k, 0);
          }
          for (const tier of [0, 1]) {
            if (subs[tier].length) link.send(JSON.stringify({ t: 'sub', c: subs[tier], tier }));
          }
          const ps = [...players.values()].map(playerRecord);
          for (let k = 0; k < ps.length; k += 2000) link.send(JSON.stringify({ t: 'player', p: ps.slice(k, k + 2000) }));
        },
        onMessage: (data, isBinary) => onShardMessage(i, data, isBinary),
      },
    );
    shardLinks.push(link);
  });

  // Chunk ownership changes at runtime (load balancing). The coordinator
  // (shard 0) broadcasts the map; streams of moved chunks are re-subscribed
  // at the new owner, and their clients resync from its first keyframe.
  function applyMap(msg) {
    if (!Array.isArray(msg.owner) || msg.version <= topo.version) return;
    const before = Array.from(topo.owner);
    try {
      topo.setOwners(msg.owner, msg.version);
    } catch (err) {
      log('bad map', err.message);
      return;
    }
    let moved = 0;
    for (const [k, st] of chunkState) {
      const id = k >> 1;
      const from = before[id];
      const to = topo.owner[id];
      if (from === to) continue;
      moved++;
      st.cache = [];
      for (const c of st.clients) c.chunks.set(k, 0);
      pendingUnsub[to].delete(k);
      pendingSub[to].add(k);
      pendingSub[from].delete(k);
      pendingUnsub[from].add(k);
    }
    if (moved) log(`map v${msg.version}: re-subscribed ${moved} stream(s)`);
  }

  function playerRecord(c) {
    return { pid: c.pid, name: c.name, rgb: c.rgb, hue: c.hue, ipHash: c.ipHash };
  }

  // ---------------------------------------------------------- moderation
  // Sanctions are decided on shard 0 (see control.js) and pushed to every
  // gateway, which enforces them: banned IPs are refused at the handshake,
  // banned identities at hello, muted players' chat is dropped.
  const bannedPids = new Map(); // pid -> until (0 = permanent)
  const bannedIps = new Map(); // ipHash -> until
  const mutedPids = new Map(); // pid -> until
  function ipHashOf(ip) {
    return crypto.createHmac('sha256', tokenSecret).update('ip:' + ip).digest('base64url').slice(0, 16);
  }
  const live = (until) => !until || until > Date.now();
  function applySanctions(list) {
    bannedPids.clear();
    bannedIps.clear();
    mutedPids.clear();
    for (const s of list || []) {
      const target = s.kind === 'mute' ? mutedPids : bannedPids;
      if (Number.isInteger(s.pid)) target.set(s.pid, s.until || 0);
      if (s.kind === 'ban' && s.ipHash) bannedIps.set(s.ipHash, s.until || 0);
    }
    for (const c of clients) {
      if ((bannedPids.has(c.pid) && live(bannedPids.get(c.pid))) || (bannedIps.has(c.ipHash) && live(bannedIps.get(c.ipHash)))) {
        c.ws.close(4003, 'banned');
      }
    }
  }
  const isBanned = (pid, ipHash) =>
    (bannedPids.has(pid) && live(bannedPids.get(pid))) || (bannedIps.has(ipHash) && live(bannedIps.get(ipHash)));

  // Optional chat word list (one entry per line, case-insensitive).
  let blockRe = null;
  if (blocklistFile) {
    try {
      const words = fs
        .readFileSync(blocklistFile, 'utf8')
        .split(/\r?\n/)
        .map((w) => w.trim())
        .filter((w) => w && !w.startsWith('#'));
      if (words.length) blockRe = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'giu');
      log(`chat blocklist: ${words.length} entries`);
    } catch (err) {
      log(`could not read blocklist ${blocklistFile}: ${err.message}`);
    }
  }

  // World chat goes through the same automatic rules as private messages
  // (masking, links, contact-info scams, repeats, strikes -> auto-mute).
  const guestMuted = new Map(); // pid -> until (guests: this gateway only)
  const moderator = new Moderator({
    blocklist: blockRe,
    allowDomains: String(opts.allowDomains ?? cfg.get('allow-domains', 'ALLOW_DOMAINS', ''))
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean),
    onAutoMute: (pid, until) => {
      const c = players.get(pid);
      if (c && c.acct) {
        c.mutedUntil = until;
        meta.call('mod.autoMute', { acct: c.acct, until, reasons: 'world-chat' }, { acct: c.acct }).catch(() => {});
      } else guestMuted.set(pid, until);
      if (c) send(c, JSON.stringify({ t: 'notice', text: '多次发送违规内容，已被自动禁言 10 分钟。' }));
    },
  });
  const REASON_TEXT = { link: '含外部链接', contact: '含联系方式（只能发给好友）', repeat: '重复刷屏', empty: '空消息' };
  const reasonText = (rs) => rs.map((r) => REASON_TEXT[r] || r).join('、');

  // ------------------------------------------------------------ meta
  // Accounts, items, trading, friends and messages live in the meta
  // service (src/meta). The gateway authenticates the socket once, then
  // forwards whitelisted calls stamped with the verified account id.
  const metaUrls = opts.metaUrls ?? JSON.parse(cfg.get('meta-urls', 'META_URLS', '[]'));
  const conns = new Map(); // conn id -> client
  let connSeq = 0;
  const meta = new MetaClient(
    metaUrls,
    { t: 'hello', role: 'gateway', id: gwId, secret },
    {
      log,
      // A (re)started replica knows nothing about who is online here.
      onOpen: (i) => {
        for (const c of clients) if (c.acct && meta.homeOf(c.acct) === i) meta.send(i, { t: 'online', acct: c.acct, conn: c.conn });
      },
      onPush: (conn, ev) => {
        const c = conns.get(conn);
        if (!c || !ev) return;
        if (ev.type === 'muted') c.mutedUntil = Number(ev.until) || 0;
        send(c, JSON.stringify({ t: 'ev', ev }));
        if (ev.type === 'banned') c.ws.close(4003, 'banned');
      },
    },
  );
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function metaRetry(m, a, ctx) {
    for (let k = 0; ; k++) {
      try {
        return await meta.call(m, a, ctx);
      } catch (err) {
        if (k >= 5 || !['TIMEOUT', 'META_DOWN'].includes(err.code)) throw err;
        await sleep(500 * 2 ** k);
      }
    }
  }

  // Request/reply with the shard that owns a point (capture, release).
  const shardPending = new Map();
  let shardSeq = 0;
  function shardRequest(shard, msg, timeoutMs = 4000) {
    return new Promise((resolve) => {
      const reqId = ++shardSeq;
      const timer = setTimeout(() => {
        shardPending.delete(reqId);
        resolve({ ok: false, code: 'TIMEOUT', msg: '世界服务器超时' });
      }, timeoutMs);
      shardPending.set(reqId, { resolve, timer });
      if (!shardLinks[shard].send(JSON.stringify({ ...msg, reqId }))) {
        clearTimeout(timer);
        shardPending.delete(reqId);
        resolve({ ok: false, code: 'SHARD_DOWN', msg: '世界服务器不可用' });
      }
    });
  }

  function worldPoint(a, c) {
    const x = Number(a.x);
    const y = Number(a.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= topo.width || y >= topo.height) {
      throw new MetaError('BAD_ARG', '位置无效');
    }
    const at = topo.chunkAt(x, y);
    if (!c.chunks.has(skey(at, 0)) && !c.chunks.has(skey(at, 1))) throw new MetaError('NOT_VISIBLE', '只能对视野里的位置操作');
    return [x, y];
  }

  // World organism -> inventory item. Order: quota check, shard removes the
  // organism and returns its data, meta records the item (idempotent key, so
  // retries are safe). Fails closed: a lost reply costs the organism, never
  // duplicates an item.
  async function capture(c, a) {
    if (!c.acct) throw new MetaError('LOGIN_REQUIRED', '登录后才能收集生物');
    const [x, y] = worldPoint(a, c);
    const entityId = Number(a.entityId);
    if (!Number.isSafeInteger(entityId) || entityId <= 0) throw new MetaError('BAD_ARG', '目标无效');
    if (!(await meta.call('item.captureAllowed', {}, { acct: c.acct }))) throw new MetaError('LIMIT', '今天的收集次数已用完');
    const res = await shardRequest(topo.ownerAt(x, y), { t: 'capture', pid: c.pid, entityId, x, y });
    if (!res.ok) throw new MetaError(res.code, res.msg || '收集失败');
    return metaRetry('item.captured', { key: res.key, data: res.data }, { acct: c.acct });
  }

  // Inventory item -> world organism. The item (and fee) is consumed first,
  // then the owning shard spawns it once per key (retried across moves).
  async function release(c, a) {
    if (!c.acct) throw new MetaError('LOGIN_REQUIRED', '请先登录');
    const [x, y] = worldPoint(a, c);
    const r = await meta.call('item.release', { item: a.item }, { acct: c.acct });
    for (let k = 0; k < 6; k++) {
      const s = await shardRequest(topo.ownerAt(x, y), { t: 'spawn', key: r.spawnKey, pid: c.pid, x, y, data: r.data });
      if (s.ok) return { item: r.item, entity: s.id ?? 0 };
      if (s.code === 'BAD_ITEM') break;
      await sleep(300 * (k + 1));
    }
    log(`release ${r.spawnKey} for ${c.acct} could not spawn`);
    meta.call('admin.note', { action: 'release-failed', target: `acct:${c.acct}`, detail: r.spawnKey }, { superuser: true }).catch(() => {});
    throw new MetaError('SPAWN_FAILED', '物品已消耗但放回世界失败，已记录，请联系管理员');
  }

  const registrations = new Map(); // ip -> [t]
  const registerPerHour = Number(opts.registerPerHour ?? cfg.get('register-per-hour', 'REGISTER_PER_IP_HOUR', 5));
  function rpcReply(c, id, body) {
    send(c, JSON.stringify({ t: 'rpcr', id, ...body }));
  }
  async function onRpc(c, msg) {
    const id = msg.id;
    const m = String(msg.m || '');
    const a = msg.a && typeof msg.a === 'object' && !Array.isArray(msg.a) ? msg.a : {};
    if (c.rpcTokens <= 0) return rpcReply(c, id, { ok: false, code: 'RATE', msg: '操作太频繁' });
    c.rpcTokens--;
    try {
      let r;
      if (m === 'item.capture') r = await capture(c, a);
      else if (m === 'item.release') r = await release(c, a);
      else {
        if (!Object.hasOwn(CLIENT_METHODS, m)) throw new MetaError('NO_METHOD', '未知操作');
        if (CLIENT_METHODS[m] && !c.acct) throw new MetaError('LOGIN_REQUIRED', '请先登录');
        if (m === 'auth.register') {
          const now = Date.now();
          const list = (registrations.get(c.ip) || []).filter((t) => now - t < 3600000);
          if (list.length >= registerPerHour) throw new MetaError('RATE', '这个网络注册太频繁，请稍后再试');
          list.push(now);
          registrations.set(c.ip, list);
          if (registrations.size > 100000) registrations.clear();
        }
        const args = m === 'auth.logout' ? { token: c.session } : a;
        r = await meta.call(m, args, { acct: c.acct, ip: c.ip, ua: c.ua, key: String(a.name ?? '').toLowerCase() });
      }
      rpcReply(c, id, { ok: true, r: r ?? null });
    } catch (err) {
      rpcReply(c, id, { ok: false, code: err.code || 'INTERNAL', msg: err.code ? err.message : '服务器错误' });
    }
  }

  // Admin API: HTTP on the gateway, answered by shard 0 over the link.
  let pendingPlayers = [];
  const adminPending = new Map();
  let adminSeq = 0;
  function adminRequest(op, args) {
    return new Promise((resolve) => {
      const id = ++adminSeq;
      const timer = setTimeout(() => {
        adminPending.delete(id);
        resolve({ ok: false, error: 'control shard did not answer' });
      }, 3000);
      adminPending.set(id, { resolve, timer });
      if (!shardLinks[0].send(JSON.stringify({ t: 'admin', id, op, args }))) {
        clearTimeout(timer);
        adminPending.delete(id);
        resolve({ ok: false, error: 'control shard unreachable' });
      }
    });
  }
  const adminFails = new Map(); // ip -> { n, t }
  const staffCache = new Map(); // session token -> { who, t }
  const ROLE_RANK = { player: 0, mod: 1, admin: 2 };
  // Who is calling: ADMIN_TOKEN (superuser), or a staff account's session
  // token (role mod/admin, checked against meta, cached 30 s), or null.
  async function adminIdentity(req, ip) {
    const f = adminFails.get(ip);
    if (f && f.n >= 10 && Date.now() - f.t < 60000) return null; // slow down guessing
    const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const fail = () => {
      adminFails.set(ip, { n: (f && Date.now() - f.t < 60000 ? f.n : 0) + 1, t: Date.now() });
      return null;
    };
    if (!got) return fail();
    if (adminToken) {
      const a = crypto.createHash('sha256').update(got).digest();
      const b = crypto.createHash('sha256').update(adminToken).digest();
      if (crypto.timingSafeEqual(a, b)) return { superuser: true, role: 'admin', acct: 0, name: 'ADMIN_TOKEN' };
    }
    if (!meta.enabled || !got.startsWith('S')) return fail();
    const hit = staffCache.get(got);
    if (hit && Date.now() - hit.t < 30000) return hit.who;
    let acct = null;
    try {
      acct = await meta.call('auth.resume', { token: got }, { key: got });
    } catch {
      return null;
    }
    if (!acct || !(ROLE_RANK[acct.role] >= 1)) return fail();
    const who = { superuser: false, role: acct.role, acct: acct.id, name: acct.name };
    staffCache.set(got, { who, t: Date.now() });
    if (staffCache.size > 1000) staffCache.clear();
    return who;
  }
  // World-side operations (answered by shard 0) -> minimum role.
  const ADMIN_GET = { state: 'mod', players: 'mod' };
  const ADMIN_POST = { mute: 'mod', kick: 'mod', lift: 'mod', ban: 'admin', move: 'admin', balance: 'admin' };
  function readBody(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (d) => {
        body += d;
        if (body.length > 4096) req.destroy();
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    });
  }
  async function handleAdminHttp(req, res, url) {
    const json = (code, body) => {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(body));
    };
    if (!adminToken && !meta.enabled) return json(404, { error: 'admin API disabled (set ADMIN_TOKEN or run the meta service)' });
    const op = url.pathname.slice('/admin/api/'.length);
    const ip = clientIp(req);
    // Staff log in with their game account (password + 2FA if enabled).
    if (op === 'login' && req.method === 'POST') {
      if (!meta.enabled) return json(404, { error: 'accounts disabled' });
      const f = adminFails.get(ip);
      if (f && f.n >= 10 && Date.now() - f.t < 60000) return json(429, { error: '尝试太多次' });
      const body = await readBody(req);
      if (!body) return json(400, { error: 'bad JSON' });
      try {
        const r = await meta.call('auth.login', { name: body.name, password: body.password, totp: body.totp }, { key: String(body.name ?? '').toLowerCase(), ip, ua: 'admin' });
        if (!(ROLE_RANK[r.account.role] >= 1)) {
          meta.call('auth.logout', { token: r.token }, { acct: r.account.id }).catch(() => {});
          return json(403, { error: '这个账号不是管理人员' });
        }
        return json(200, { token: r.token, account: r.account });
      } catch (err) {
        return json(401, { error: err.message, code: err.code });
      }
    }
    const who = await adminIdentity(req, ip);
    if (!who) return json(401, { error: 'unauthorized' });
    if (op === 'whoami') return json(200, { role: who.role, name: who.name, superuser: who.superuser, meta: meta.enabled });
    const ctx = { acct: who.acct, superuser: who.superuser };
    if (op.startsWith('meta/')) {
      const name = op.slice(5);
      const spec = Object.hasOwn(ADMIN_METHODS, name) ? ADMIN_METHODS[name] : null;
      if (!spec || spec.method !== req.method) return json(404, { error: 'unknown admin endpoint' });
      if (ROLE_RANK[who.role] < ROLE_RANK[spec.role]) return json(403, { error: '权限不足' });
      const args = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readBody(req);
      if (!args) return json(400, { error: 'bad JSON' });
      try {
        return json(200, (await meta.call(`admin.${name}`, args, ctx)) ?? {});
      } catch (err) {
        return json(err.code === 'FORBIDDEN' ? 403 : 400, { error: err.message, code: err.code });
      }
    }
    if (req.method === 'GET' && Object.hasOwn(ADMIN_GET, op)) {
      if (ROLE_RANK[who.role] < ROLE_RANK[ADMIN_GET[op]]) return json(403, { error: '权限不足' });
      const r = await adminRequest(op, { q: url.searchParams.get('q') || '' });
      return json(r.ok ? 200 : 502, r.ok ? r.result : { error: r.error });
    }
    if (req.method === 'POST' && Object.hasOwn(ADMIN_POST, op)) {
      if (ROLE_RANK[who.role] < ROLE_RANK[ADMIN_POST[op]]) return json(403, { error: '权限不足' });
      const args = await readBody(req);
      if (!args) return json(400, { error: 'bad JSON' });
      const r = await adminRequest(op, args);
      // Every staff action lands in the audit log (who, what, to whom).
      if (r.ok && meta.enabled) meta.call('admin.note', { action: op, target: args.pid ?? args.chunk ?? '', detail: args }, ctx).catch(() => {});
      return json(r.ok ? 200 : 400, r.ok ? r.result : { error: r.error });
    }
    return json(404, { error: 'unknown admin endpoint' });
  }

  function onShardMessage(shard, data, isBinary) {
    counters.bytesIn += isBinary ? data.length : data.length;
    if (!isBinary) {
      const msg = JSON.parse(data.toString());
      if (msg.t === 'lb') lbByShard.set(shard, msg);
      else if (msg.t === 'map') applyMap(msg);
      else if (msg.t === 'mapd') {
        if (msg.version <= topo.version) return;
        if (msg.prev !== topo.version) shardLinks[0].send(JSON.stringify({ t: 'mapreq' }));
        else {
          const owner = Array.from(topo.owner);
          for (const [id, to] of msg.set) owner[id] = to;
          applyMap({ version: msg.version, owner });
        }
      }
      else if (msg.t === 'sanctions') applySanctions(msg.list);
      else if (msg.t === 'kick') for (const pid of msg.pids || []) players.get(pid)?.ws.close(4001, 'kicked');
      else if (msg.t === 'capr' || msg.t === 'spawnr') {
        const p = shardPending.get(msg.reqId);
        if (p) {
          shardPending.delete(msg.reqId);
          clearTimeout(p.timer);
          p.resolve(msg);
        }
      } else if (msg.t === 'adminr') {
        const p = adminPending.get(msg.id);
        if (p) {
          adminPending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg);
        }
      }
      return;
    }
    if (data[0] === S_BATCH) unpackBatch(data, (m) => onShardBinary(m));
    else onShardBinary(data);
  }

  function onShardBinary(data) {
    const type = data[0];
    if (type === S_CHUNK) {
      counters.framesIn++;
      const h = peekChunkHeader(data);
      const k = skey(h.chunkId, h.flags & F_LO ? 1 : 0);
      const st = chunkState.get(k);
      if (!st) return;
      if (h.flags & F_KEY) st.cache = [data];
      else if (st.cache.length > 0) {
        st.cache.push(data);
        if (st.cache.length > 120) st.cache = [];
      }
      for (const c of st.clients) deliverChunk(c, k, st, data);
    } else if (type === S_FIELD || type === S_EVENTS) {
      const r = new Reader(data);
      r.u8();
      const id = r.varint();
      for (const tier of [0, 1]) {
        const st = chunkState.get(skey(id, tier));
        if (!st) continue;
        for (const c of st.clients) {
          if (backlog(c) < highWater) send(c, data);
          else counters.dropped++;
        }
      }
    } else if (type === I_SUMMARY) {
      const r = new Reader(data);
      r.u8();
      const n = r.varint();
      for (let k = 0; k < n; k++) {
        const id = r.varint();
        const pop = r.u16();
        const rgb = r.u24();
        const nut = r.u8();
        if (id < topo.chunkCount) {
          summary.pop[id] = pop;
          summary.rgb[id] = rgb;
          summary.nutrient[id] = nut;
        }
      }
    }
  }

  // Binary output is queued per client and flushed once per event-loop turn
  // as a single S_BATCH message (see packBatch). Text (rare) goes directly.
  const dirty = new Set();
  let flushScheduled = false;
  function send(c, data) {
    if (c.ws.readyState !== 1) return;
    const n = typeof data === 'string' ? data.length : data.byteLength;
    c.bytesOut += n;
    counters.bytesOut += n;
    if (typeof data === 'string') {
      c.ws.send(data);
      counters.msgsOut++;
      return;
    }
    c.queue.push(data);
    c.queued += n;
    dirty.add(c);
    if (!flushScheduled) {
      flushScheduled = true;
      setImmediate(flushClients);
    }
  }

  function flushClients() {
    flushScheduled = false;
    for (const c of dirty) {
      if (c.queue.length && c.ws.readyState === 1) {
        c.ws.send(packBatch(c.queue), { binary: true });
        counters.msgsOut++;
      }
      c.queue = [];
      c.queued = 0;
    }
    dirty.clear();
  }

  function backlog(c) {
    return c.ws.bufferedAmount + c.queued;
  }

  // State per (client, chunk): 1 = in sync, receives deltas; 0 = needs a
  // keyframe chain. Deltas are only valid on top of everything before them,
  // so a frame is never dropped for an in-sync client: it is either sent or
  // the client is marked out of sync and later caught up from the cache.
  function deliverChunk(c, k, st, data) {
    const state = c.chunks.get(k);
    const congested = backlog(c) > highWater;
    if (state === 1) {
      if (congested) {
        c.chunks.set(k, 0);
        counters.dropped++;
        return;
      }
      send(c, data);
      return;
    }
    if (congested || st.cache.length === 0) return;
    if (replay(c, st)) {
      c.chunks.set(k, 1);
      counters.resyncs++;
    }
  }

  // Catch-up replays (keyframe + deltas) are the one place a tiny client
  // message can trigger a large download, so they draw from a per-client
  // byte budget (REPLAY_RATE/s, REPLAY_BURST max). Without budget the chunk
  // simply stays unsynced and is retried on its next frame.
  function replay(c, st) {
    let bytes = 0;
    for (const f of st.cache) bytes += f.byteLength;
    if (bytes > c.replayTokens) return false;
    c.replayTokens -= bytes;
    for (const f of st.cache) send(c, f);
    return true;
  }

  // c.chunks maps stream key -> sync state; pendingSub/Unsub hold stream keys.
  function subscribe(c, k) {
    let st = chunkState.get(k);
    if (!st) {
      st = { clients: new Set(), cache: [], unsubAt: 0 };
      chunkState.set(k, st);
      const owner = topo.ownerOf(k >> 1);
      pendingUnsub[owner].delete(k);
      pendingSub[owner].add(k);
    }
    st.unsubAt = 0;
    st.clients.add(c);
    c.chunks.set(k, 0);
    if (st.cache.length > 0 && backlog(c) < highWater && replay(c, st)) c.chunks.set(k, 1);
  }

  function unsubscribe(c, k) {
    const st = chunkState.get(k);
    c.chunks.delete(k);
    if (!st) return;
    st.clients.delete(c);
    // Keep the shard subscription warm for a few seconds: players pan back
    // and forth, and re-subscribing costs a forced keyframe.
    if (st.clients.size === 0) st.unsubAt = Date.now() + 5000;
  }

  function applyView(c, now) {
    const { rect, tier } = c.pendingView;
    c.pendingView = null;
    c.lastViewAt = now;
    const [x0, y0, x1, y1] = rect;
    c.view = rect;
    const want = topo.viewChunks(x0, y0, x1, y1, viewMargin, tier ? maxChunksLo : maxChunks);
    const wantSet = new Set((want || []).map((id) => skey(id, tier)));
    for (const k of [...c.chunks.keys()]) if (!wantSet.has(k)) unsubscribe(c, k);
    for (const k of wantSet) if (!c.chunks.has(k)) subscribe(c, k);
  }

  // ------------------------------------------------------------- clients
  function onClientBinary(c, buf) {
    if (buf.length < 1) return;
    const r = new Reader(buf);
    const type = r.u8();
    const now = Date.now();
    if (type === C_VIEW) {
      if (buf.length !== 17 && buf.length !== 18) return;
      const x0 = r.f32();
      const y0 = r.f32();
      const x1 = r.f32();
      const y1 = r.f32();
      const tier = buf.length === 18 && r.u8() === 1 ? 1 : 0;
      if (![x0, y0, x1, y1].every(Number.isFinite)) return;
      // At most 10 view changes per second; the latest one wins.
      c.pendingView = { rect: [x0, y0, x1, y1], tier };
      if (now - c.lastViewAt >= 100) applyView(c, now);
      return;
    }
    if (type === C_ACTION) {
      if (buf.length !== 18) return;
      const a = { type: r.u8(), x: r.f32(), y: r.f32(), dx: r.f32(), dy: r.f32() };
      if (![a.x, a.y, a.dx, a.dy].every(Number.isFinite)) return;
      if (a.x < 0 || a.y < 0 || a.x >= topo.width || a.y >= topo.height) return;
      if (Math.abs(a.dx) > 1e4 || Math.abs(a.dy) > 1e4) return;
      const cd = ACTION_COOLDOWN_MS[a.type];
      if (cd === undefined) return;
      const last = c.cooldowns.get(a.type) || 0;
      if (now - last < cd * 0.9) return;
      c.cooldowns.set(a.type, now);
      // Must be somewhere the player can see: no remote griefing of far chunks.
      const at = topo.chunkAt(a.x, a.y);
      if (!c.chunks.has(skey(at, 0)) && !c.chunks.has(skey(at, 1))) return;
      actionBatch[topo.ownerAt(a.x, a.y)].push({ pid: c.pid, ...a });
      counters.actions++;
      return;
    }
    if (type === C_CURSOR) {
      if (buf.length !== 9) return;
      const x = r.f32();
      const y = r.f32();
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      c.cursor = [x, y];
      c.cursorDirty = true;
      return;
    }
    if (type === C_PING) {
      if (buf.length !== 5) return;
      const w = new Writer(5).u8(S_PONG).u32(r.u32());
      send(c, w.finish());
    }
  }

  function onClientJson(c, msg) {
    if (msg.t === 'chat') {
      const now = Date.now();
      if (now - c.lastChat < 1200) return;
      c.lastChat = now;
      const raw = cleanText(msg.text, 200);
      if (!raw) return;
      if ((mutedPids.has(c.pid) && live(mutedPids.get(c.pid))) || c.mutedUntil > now || (guestMuted.get(c.pid) || 0) > now) {
        send(c, JSON.stringify({ t: 'notice', text: '你已被禁言，消息未发送。' }));
        return;
      }
      const mod = moderator.check(raw, { account: c.pid, channel: 'world', toFriend: false });
      if (!mod.ok) {
        send(c, JSON.stringify({ t: 'notice', text: `消息未发送：${reasonText(mod.reasons)}` }));
        return;
      }
      const text = mod.text;
      const [x, y] = c.cursor || (c.view ? [(c.view[0] + c.view[2]) / 2, (c.view[1] + c.view[3]) / 2] : [0, 0]);
      const cx = Math.max(0, Math.min(topo.width - 1, x));
      const cy = Math.max(0, Math.min(topo.height - 1, y));
      shardLinks[topo.ownerAt(cx, cy)].send(JSON.stringify({ t: 'chat', pid: c.pid, x: cx, y: cy, text }));
    } else if (msg.t === 'rpc') onRpc(c, msg);
  }

  async function onHello(c, msg) {
    // A logged-in player's world identity is their account id; guests get
    // a signed random id in the guest range (see readToken).
    let account = null;
    if (typeof msg.session === 'string' && msg.session && meta.enabled) {
      c.helloing = true;
      try {
        account = await meta.call('auth.resume', { token: msg.session }, { key: msg.session });
      } catch (err) {
        if (err.code === 'BANNED') return c.ws.close(4003, 'banned');
        send(c, JSON.stringify({ t: 'notice', text: '账号服务暂时不可用，先以游客身份进入。' }));
      }
      c.helloing = false;
      if (c.ws.readyState !== 1) return;
      if (!account) send(c, JSON.stringify({ t: 'ev', ev: { type: 'session-expired' } }));
    }
    let pid;
    if (account) {
      pid = account.id;
      if (isBanned(pid, c.ipHash)) return c.ws.close(4003, 'banned');
      // The same account opened again on this gateway: newest tab wins.
      const old = players.get(pid);
      if (old) {
        players.delete(pid);
        old.ws.close(4004, 'replaced');
      }
      c.acct = account.id;
      c.session = msg.session;
      c.mutedUntil = Number(account.mutedUntil) || 0;
      msg = { ...msg, name: account.name, hue: account.hue };
      meta.send(meta.homeOf(c.acct), { t: 'online', acct: c.acct, conn: c.conn });
    } else {
      pid = readToken(msg.token);
      if (pid && isBanned(pid, c.ipHash)) return c.ws.close(4003, 'banned');
      if (!pid || players.has(pid)) {
        // New identity (or the same token open twice: give the second tab its own id).
        do pid = crypto.randomInt(GUEST_PID_MIN, 2 ** 31);
        while (players.has(pid));
      }
    }
    c.pid = pid;
    c.name = cleanText(msg.name, 24) || `cell-${pid % 10000}`;
    const hue = Number(msg.hue);
    c.hue = Number.isFinite(hue) ? ((hue % 1) + 1) % 1 : (pid % 360) / 360;
    c.rgb = hueToRgb(c.hue);
    players.set(pid, c);
    // Registrations are batched (flushTimer): at 100k players a join storm
    // would otherwise be one message per join per shard.
    pendingPlayers.push(playerRecord(c));
    send(
      c,
      JSON.stringify({
        t: 'welcome',
        v: PROTOCOL_VERSION,
        pid,
        token: makeToken(pid),
        name: c.name,
        hue: c.hue,
        rgb: c.rgb,
        world,
        posQuant: POS_QUANT,
        netHz,
        maxChunks,
        maxChunksLo,
        viewMargin,
        cooldowns: ACTION_COOLDOWN_MS,
        gateway: gwId,
        zones,
        zone: myZone,
        account,
        meta: meta.enabled,
      }),
    );
  }

  // --------------------------------------------------------- web server
  // Only origin-form targets ("/path?query"); anything else is rejected
  // (an absolute-form target like "http://a:b:c/" would otherwise throw).
  function safeUrl(target) {
    if (typeof target !== 'string' || target[0] !== '/') return null;
    try {
      return new URL(target, 'http://x');
    } catch {
      return null;
    }
  }
  const publicDir = path.join(ROOT, 'public');
  const sharedDir = path.join(ROOT, 'src/shared');
  const server = http.createServer((req, res) => {
    const url = safeUrl(req.url);
    if (!url) {
      res.statusCode = 400;
      res.end();
      return;
    }
    if (url.pathname === '/healthz') {
      res.end('ok');
      return;
    }
    if (url.pathname.startsWith('/admin/api/')) {
      handleAdminHttp(req, res, url).catch((err) => {
        log("admin request failed", err.message);
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      });
      return;
    }
    if (url.pathname === '/metrics') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(metrics()));
      return;
    }
    let base = publicDir;
    let rel = url.pathname;
    if (rel.startsWith('/shared/')) {
      base = sharedDir;
      rel = rel.slice('/shared'.length);
    }
    if (rel === '/') rel = '/index.html';
    else if (rel === '/admin') rel = '/admin.html';
    const file = path.join(base, path.normalize(rel));
    if (!file.startsWith(base + path.sep)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('x-content-type-options', 'nosniff');
      res.end(body);
    });
  });

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false, // CPU per client; frames are already compact
    maxPayload: 4096,
  });

  server.on('upgrade', (req, socket, head) => {
    const url = safeUrl(req.url);
    // /ws, or /z/<n>/ws when a proxy routes zones by path without stripping it.
    if (!url || !(url.pathname === '/ws' || /^\/z\/\d+\/ws$/.test(url.pathname))) {
      socket.destroy();
      return;
    }
    if (origins.length && !origins.includes(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const ip = clientIp(req);
    if (isBanned(-1, ipHashOf(ip))) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if ((perIp.get(ip) || 0) >= maxPerIp || clients.size >= maxClients) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip, String(req.headers['user-agent'] || '').slice(0, 120)));
  });

  // Behind a proxy the TCP peer is the proxy. IP_HEADER names a header the
  // proxy overwrites (e.g. cf-connecting-ip for Cloudflare); otherwise take
  // X-Forwarded-For counted from the RIGHT: proxies append, so the left end
  // is whatever the client typed and must not be trusted.
  function clientIp(req) {
    const peer = req.socket.remoteAddress || '?';
    if (!trustProxy) return peer;
    if (ipHeader) {
      const v = req.headers[ipHeader];
      return (typeof v === 'string' && v.trim()) || peer;
    }
    const parts = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    return parts.length >= proxyHops ? parts[parts.length - proxyHops] : peer;
  }

  function onConnection(ws, ip, ua = '') {
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    const c = {
      ws,
      ip,
      ua,
      conn: ++connSeq,
      acct: 0,
      session: '',
      mutedUntil: 0,
      helloing: false,
      rpcTokens: 20,
      ipHash: ipHashOf(ip),
      pid: 0,
      name: '',
      hue: 0,
      rgb: 0,
      chunks: new Map(),
      view: null,
      cursor: null,
      cursorDirty: false,
      cursorShard: -1,
      cooldowns: new Map(),
      lastChat: 0,
      pendingView: null,
      lastViewAt: 0,
      replayTokens: REPLAY_BURST,
      alive: true,
      tokens: 200,
      strikes: 0,
      bytesOut: 0,
      queue: [],
      queued: 0,
    };
    clients.add(c);
    conns.set(c.conn, c);
    const helloTimer = setTimeout(() => {
      if (!c.pid) ws.close(1008, 'hello timeout');
    }, 10000);
    ws.on('message', (data, isBinary) => {
      // Token bucket: 200 burst, refilled at 100 msg/s in the 50 ms flush.
      if (c.tokens <= 0) {
        if (++c.strikes > 1000) ws.close(1008, 'rate limit');
        return;
      }
      c.tokens--;
      try {
        if (!c.pid) {
          if (isBinary || c.helloing) return;
          const msg = JSON.parse(data.toString());
          if (msg.t === 'hello') {
            clearTimeout(helloTimer);
            onHello(c, msg);
          }
          return;
        }
        if (isBinary) onClientBinary(c, data);
        else onClientJson(c, JSON.parse(data.toString()));
      } catch {
        // Malformed input is ignored; the rate limiter handles floods.
      }
    });
    ws.on('pong', () => (c.alive = true));
    ws.on('close', () => {
      clearTimeout(helloTimer);
      clients.delete(c);
      const n = (perIp.get(ip) || 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
      for (const id of [...c.chunks.keys()]) unsubscribe(c, id);
      if (c.pid && players.get(c.pid) === c) players.delete(c.pid);
      conns.delete(c.conn);
      if (c.acct) meta.send(meta.homeOf(c.acct), { t: 'offline', conn: c.conn });
      if (c.cursorShard >= 0) cursorBatch[c.cursorShard].set(c.pid, [NaN, NaN]);
    });
    ws.on('error', () => {});
  }

  // --------------------------------------------------- periodic flushing
  const flushTimer = setInterval(() => {
    for (const c of clients) {
      c.tokens = Math.min(200, c.tokens + 5);
      c.rpcTokens = Math.min(20, c.rpcTokens + 0.25); // 5 calls/s sustained
      c.replayTokens = Math.min(REPLAY_BURST, c.replayTokens + REPLAY_RATE / 20);
      if (c.pendingView && Date.now() - c.lastViewAt >= 100) applyView(c, Date.now());
      if (c.cursorDirty && c.pid) {
        c.cursorDirty = false;
        const [x, y] = c.cursor;
        const inWorld = x >= 0 && y >= 0 && x < topo.width && y < topo.height;
        const shard = inWorld ? topo.ownerAt(x, y) : -1;
        if (c.cursorShard >= 0 && c.cursorShard !== shard) cursorBatch[c.cursorShard].set(c.pid, [NaN, NaN]);
        if (shard >= 0) cursorBatch[shard].set(c.pid, c.cursor);
        c.cursorShard = shard;
      }
    }
    if (pendingPlayers.length) {
      const msg = JSON.stringify({ t: 'player', p: pendingPlayers });
      pendingPlayers = [];
      for (const l of shardLinks) l.send(msg); // closed links get everyone on reconnect
    }
    for (let s = 0; s < shardLinks.length; s++) {
      const link = shardLinks[s];
      if (!link.open) {
        // Nobody to deliver to: don't let input pile up (it would also
        // arrive as one stale burst when the shard comes back).
        actionBatch[s] = [];
        cursorBatch[s].clear();
        continue;
      }
      for (const [t, pending] of [
        ['sub', pendingSub[s]],
        ['unsub', pendingUnsub[s]],
      ]) {
        if (!pending.size) continue;
        const byTier = [[], []];
        for (const k of pending) byTier[k & 1].push(k >> 1);
        for (const tier of [0, 1]) if (byTier[tier].length) link.send(JSON.stringify({ t, c: byTier[tier], tier }));
        pending.clear();
      }
      if (actionBatch[s].length) {
        const list = actionBatch[s];
        const w = new Writer(8 + list.length * 24).u8(I_ACTIONS).varint(list.length);
        for (const a of list) w.varint(a.pid).u8(a.type).f32(a.x).f32(a.y).f32(a.dx).f32(a.dy);
        link.send(w.finish());
        actionBatch[s] = [];
      }
      if (cursorBatch[s].size) {
        const m = cursorBatch[s];
        const w = new Writer(8 + m.size * 14).u8(I_CURSORS).varint(m.size);
        for (const [pid, [x, y]] of m) w.varint(pid).f32(x).f32(y);
        link.send(w.finish());
        m.clear();
      }
    }
  }, 50);

  let lastCounters = { ...counters, at: Date.now() };
  let secondsTicked = 0;
  let rates = {};
  // Heartbeat: half-open connections (phone went into a tunnel, NAT dropped
  // state) would otherwise hold a slot against MAX_PER_IP for ~15 minutes.
  const heartbeatTimer = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        /* closing */
      }
    }
  }, 20000);

  const secondTimer = setInterval(() => {
    const now = Date.now();
    for (const c of clients) c.strikes = Math.max(0, c.strikes - 50);
    for (const [k, st] of chunkState) {
      if (st.clients.size === 0 && st.unsubAt && now > st.unsubAt) {
        chunkState.delete(k);
        pendingUnsub[topo.ownerOf(k >> 1)].add(k);
      }
    }
    if (shardLinks[0].open) shardLinks[0].send(JSON.stringify({ t: 'online', gw: gwId, n: players.size }));

    // World summary (encoded once for everyone), downsampled to at most
    // SUMMARY_MAX x SUMMARY_MAX cells so its size does not grow with the world.
    const sumBuf = encodeSummary();

    // Leaderboard / global stats merged over shards.
    const totals = new Map();
    const names = new Map();
    let cells = 0;
    let entities = 0;
    let tidi = 1;
    let online = 0;
    for (const lb of lbByShard.values()) {
      cells += lb.cells;
      entities += lb.entities;
      tidi = Math.min(tidi, lb.tidi);
      if (lb.online !== undefined && lb.online !== null) online = lb.online;
      for (const [pid, n, name] of lb.top) {
        totals.set(pid, (totals.get(pid) || 0) + n);
        if (name !== '?') names.set(pid, name);
      }
    }
    const top = [...totals]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([pid, n]) => [pid, names.get(pid) ?? players.get(pid)?.name ?? '?', n]);
    const statsMsg = JSON.stringify({ t: 'stats', online: Math.max(online, players.size), cells, entities, tidi, top });
    // Zoomed-out clients (watching no chunks) see the summary as the world:
    // every 2 s. Everyone else only uses it for the minimap: every 6 s.
    const tickNo = secondsTicked++;
    for (const c of clients) {
      if (!c.pid || backlog(c) > highWater) continue;
      const lod = c.view && c.chunks.size === 0;
      if (!c.gotSummary || tickNo % (lod ? 2 : 6) === 0) {
        send(c, sumBuf);
        c.gotSummary = true;
      }
      send(c, statsMsg);
    }

    const dtS = (now - lastCounters.at) / 1000;
    rates = {
      bytesOutPerSec: Math.round((counters.bytesOut - lastCounters.bytesOut) / dtS),
      // Internal traffic from shards: grows with the area this gateway's
      // players watch (zones keep it bounded, see docs/scale-100k.md).
      bytesInPerSec: Math.round((counters.bytesIn - lastCounters.bytesIn) / dtS),
      msgsOutPerSec: Math.round((counters.msgsOut - lastCounters.msgsOut) / dtS),
      framesInPerSec: Math.round((counters.framesIn - lastCounters.framesIn) / dtS),
      actionsPerSec: Math.round((counters.actions - lastCounters.actions) / dtS),
    };
    lastCounters = { ...counters, at: now };
  }, 1000);

  function encodeSummary() {
    const { chunksX, chunksY } = world;
    const bw = Math.ceil(chunksX / summaryMax);
    const bh = Math.ceil(chunksY / summaryMax);
    const cols = Math.ceil(chunksX / bw);
    const rows = Math.ceil(chunksY / bh);
    const w = new Writer(16 + cols * rows * 5).u8(S_SUMMARY).varint(cols).varint(rows).varint(bw).varint(bh);
    for (let r = 0; r < rows; r++) {
      for (let q = 0; q < cols; q++) {
        let pop = 0;
        let best = -1;
        let rgb = 0;
        let nut = 0;
        let n = 0;
        for (let y = r * bh; y < Math.min(chunksY, (r + 1) * bh); y++) {
          for (let x = q * bw; x < Math.min(chunksX, (q + 1) * bw); x++) {
            const i = y * chunksX + x;
            pop += summary.pop[i];
            nut += summary.nutrient[i];
            n++;
            if (summary.pop[i] > best) {
              best = summary.pop[i];
              rgb = summary.rgb[i];
            }
          }
        }
        w.u8(Math.min(255, Math.round(20 * Math.log2(1 + pop))))
          .u24(rgb)
          .u8(Math.round(nut / Math.max(1, n)));
      }
    }
    return w.finish();
  }

  function metrics() {
    let outside = 0;
    if (zones && myZone >= 0) for (const k of chunkState.keys()) if (topo.zoneOfChunk(zones, k >> 1) !== myZone) outside++;
    return {
      gateway: gwId,
      zone: myZone,
      watchedOutsideZone: outside, // border overlap; should stay small
      clients: clients.size,
      players: players.size,
      watchedChunks: chunkState.size,
      shards: shardLinks.map((l, i) => ({ shard: i, open: l.open })), // no internal addresses
      meta: meta.links.map((l, i) => ({ replica: i, open: l.open })),
      accounts: [...clients].filter((c) => c.acct).length,
      resyncs: counters.resyncs,
      dropped: counters.dropped,
      ...rates,
    };
  }

  await new Promise((resolve) => server.listen(port, host, resolve));
  log(`listening on http://${host}:${port}  (${clients.size} clients)`);

  return {
    port: server.address().port,
    topo,
    metrics,
    close() {
      clearInterval(flushTimer);
      clearInterval(secondTimer);
      clearInterval(heartbeatTimer);
      for (const l of shardLinks) l.close();
      meta.close();
      for (const c of clients) c.ws.terminate();
      wss.close();
      server.close();
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startGateway().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

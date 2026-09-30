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
  const maxChunksLo = Number(opts.maxChunksLo ?? cfg.get('max-chunks-lo', 'MAX_CHUNKS_LO', 80));
  const viewMargin = Number(opts.viewMargin ?? cfg.get('view-margin', 'VIEW_MARGIN', 96));
  const maxPerIp = Number(opts.maxPerIp ?? cfg.get('max-per-ip', 'MAX_PER_IP', 16));
  const maxClients = Number(opts.maxClients ?? cfg.get('max-clients', 'MAX_CLIENTS', 20000));
  const trustProxy = (opts.trustProxy ?? cfg.get('trust-proxy', 'TRUST_PROXY', '')) === 'true' || opts.trustProxy === true;
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
    if (!Number.isInteger(pid) || pid <= 0 || pid >= 2 ** 31 || typeof sig !== 'string') return 0;
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
  const counters = { bytesOut: 0, msgsOut: 0, framesIn: 0, resyncs: 0, dropped: 0, actions: 0 };

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

  function playerRecord(c) {
    return { pid: c.pid, name: c.name, rgb: c.rgb, hue: c.hue };
  }

  function onShardMessage(shard, data, isBinary) {
    if (!isBinary) {
      const msg = JSON.parse(data.toString());
      if (msg.t === 'lb') lbByShard.set(shard, msg);
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
      const text = cleanText(msg.text, 200);
      if (!text) return;
      const [x, y] = c.cursor || (c.view ? [(c.view[0] + c.view[2]) / 2, (c.view[1] + c.view[3]) / 2] : [0, 0]);
      const cx = Math.max(0, Math.min(topo.width - 1, x));
      const cy = Math.max(0, Math.min(topo.height - 1, y));
      shardLinks[topo.ownerAt(cx, cy)].send(JSON.stringify({ t: 'chat', pid: c.pid, x: cx, y: cy, text }));
    }
  }

  function onHello(c, msg) {
    let pid = readToken(msg.token);
    if (!pid || players.has(pid)) {
      // New identity (or the same token open twice: give the second tab its own id).
      do pid = crypto.randomInt(1, 2 ** 31);
      while (players.has(pid));
    }
    c.pid = pid;
    c.name = cleanText(msg.name, 24) || `cell-${pid % 10000}`;
    const hue = Number(msg.hue);
    c.hue = Number.isFinite(hue) ? ((hue % 1) + 1) % 1 : (pid % 360) / 360;
    c.rgb = hueToRgb(c.hue);
    players.set(pid, c);
    const rec = JSON.stringify({ t: 'player', p: [playerRecord(c)] });
    for (const l of shardLinks) l.send(rec);
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
    if (!url || url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    if (origins.length && !origins.includes(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const ip = clientIp(req);
    if ((perIp.get(ip) || 0) >= maxPerIp || clients.size >= maxClients) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip));
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

  function onConnection(ws, ip) {
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    const c = {
      ws,
      ip,
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
          if (isBinary) return;
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
      if (c.cursorShard >= 0) cursorBatch[c.cursorShard].set(c.pid, [NaN, NaN]);
    });
    ws.on('error', () => {});
  }

  // --------------------------------------------------- periodic flushing
  const flushTimer = setInterval(() => {
    for (const c of clients) {
      c.tokens = Math.min(200, c.tokens + 5);
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

    // World summary (encoded once for everyone).
    const w = new Writer(8 + topo.chunkCount * 6).u8(S_SUMMARY).varint(world.chunksX).varint(world.chunksY);
    for (let i = 0; i < topo.chunkCount; i++) w.u16(summary.pop[i]).u24(summary.rgb[i]).u8(summary.nutrient[i]);
    const sumBuf = w.finish();

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
    // The overview changes slowly: every 2 s is plenty (first second for new joiners).
    const sendSummary = (secondsTicked++ & 1) === 0;
    for (const c of clients) {
      if (!c.pid || backlog(c) > highWater) continue;
      if (sendSummary || !c.gotSummary) {
        send(c, sumBuf);
        c.gotSummary = true;
      }
      send(c, statsMsg);
    }

    const dtS = (now - lastCounters.at) / 1000;
    rates = {
      bytesOutPerSec: Math.round((counters.bytesOut - lastCounters.bytesOut) / dtS),
      msgsOutPerSec: Math.round((counters.msgsOut - lastCounters.msgsOut) / dtS),
      framesInPerSec: Math.round((counters.framesIn - lastCounters.framesIn) / dtS),
      actionsPerSec: Math.round((counters.actions - lastCounters.actions) / dtS),
    };
    lastCounters = { ...counters, at: now };
  }, 1000);

  function metrics() {
    return {
      gateway: gwId,
      clients: clients.size,
      players: players.size,
      watchedChunks: chunkState.size,
      shards: shardLinks.map((l, i) => ({ shard: i, open: l.open })), // no internal addresses
      resyncs: counters.resyncs,
      dropped: counters.dropped,
      ...rates,
    };
  }

  await new Promise((resolve) => server.listen(port, host, resolve));
  log(`listening on http://${host}:${port}  (${clients.size} clients)`);

  return {
    port: server.address().port,
    metrics,
    close() {
      clearInterval(flushTimer);
      clearInterval(secondTimer);
      clearInterval(heartbeatTimer);
      for (const l of shardLinks) l.close();
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

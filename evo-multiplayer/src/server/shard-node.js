// Shard node: authoritative simulation of one rectangular block of chunks.
//
//   node src/server/shard-node.js --shard 0 --port 9100 --topology '<json>'
//
// Talks to: gateways (they connect in, subscribe to chunks, send player input)
// and neighbouring shards (ghosts + migrations, over outgoing Links).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { Topology } from '../shared/topology.js';
import { Reader } from '../shared/codec.js';
import { I_ACTIONS, I_CURSORS, I_MIGRATE, I_GHOST, I_XFER, I_SUMMARY, EV_ACTION, EV_CHAT, packBatch } from '../shared/protocol.js';
import { Writer } from '../shared/codec.js';
import { Region } from './region.js';
import { Link, readClusterConfig, assertClusterSecret, secretEqual } from './link.js';
import { encodeChunkFrame, encodeField, encodeEvents } from './snapshot.js';
import { loadGame } from './game-loader.js';
import { Coordinator } from './coordinator.js';
import { Control } from './control.js';
import { MetaClient } from '../meta/meta-client.js';
import { GUEST_PID_MIN } from '../meta/methods.js';

export async function startShard(opts = {}) {
  const cfg = readClusterConfig();
  const shardId = Number(opts.shard ?? cfg.get('shard', 'SHARD_ID', 0));
  const topoCfg = opts.topology ?? cfg.topology;
  const port = Number(opts.port ?? cfg.get('port', 'PORT', 9100 + shardId));
  const host = opts.host ?? cfg.get('host', 'HOST', '127.0.0.1');
  const secret = opts.secret ?? cfg.secret;
  const tickHz = Number(opts.tickHz ?? cfg.get('tick-hz', 'TICK_HZ', 20));
  const netEvery = Number(opts.netEvery ?? cfg.get('net-every', 'NET_EVERY', 2));
  const keyEvery = Number(opts.keyEvery ?? cfg.get('key-every', 'KEY_EVERY', 30));
  const loEvery = Number(opts.loEvery ?? cfg.get('lo-every', 'LO_EVERY', 4));
  const loKeyEvery = Math.max(4, Math.round(keyEvery / loEvery)); // similar wall-clock key spacing
  const fieldEvery = Number(opts.fieldEvery ?? cfg.get('field-every', 'FIELD_EVERY', 20));
  const fieldNetRes = Number(opts.fieldNetRes ?? cfg.get('field-net-res', 'FIELD_NET_RES', 8));
  const summaryEvery = Number(opts.summaryEvery ?? cfg.get('summary-every', 'SUMMARY_EVERY', 20));
  const actionsPerChunkTick = Number(opts.actionsPerChunkTick ?? cfg.get('actions-per-chunk-tick', 'ACTIONS_PER_CHUNK_TICK', 20));
  const chatLogPerSec = Number(opts.chatLogPerSec ?? cfg.get('chat-log-per-sec', 'CHAT_LOG_PER_SEC', 100));
  let droppedActions = 0;
  let chatLogBudget = chatLogPerSec;
  const quiet = opts.quiet ?? cfg.get('quiet', 'QUIET', '') === 'true';
  const log = (...a) => {
    if (!quiet) console.log(`[shard ${shardId}]`, ...a);
  };

  const game = opts.game ?? (await loadGame(cfg.game));
  const topo = new Topology(topoCfg.world || {}, topoCfg.shards.length);
  const chunkSize = topo.world.chunkSize;
  const region = new Region({ topo, shardId, game, seed: opts.seed ?? cfg.seed });
  // Persistence: the snapshot is parsed now but applied only once the
  // coordinator has told us which chunks we own (see boot below).
  const dataDir = opts.dataDir ?? cfg.get('data-dir', 'DATA_DIR', '');
  const snapshotEvery = Number(opts.snapshotEvery ?? cfg.get('snapshot-every', 'SNAPSHOT_EVERY', 30)) * 1000;
  const snapFile = dataDir ? path.join(dataDir, `shard-${shardId}-of-${topoCfg.shards.length}.bin`) : '';
  let snap = null;
  if (snapFile && fs.existsSync(snapFile)) {
    try {
      snap = region.parseSnapshot(fs.readFileSync(snapFile));
      log(snap ? `found snapshot ${snapFile} (tick ${snap.tick}, ${snap.chunks.size} chunks)` : `ignored incompatible ${snapFile}`);
    } catch (err) {
      log(`could not read ${snapFile}: ${err.message}`);
    }
  }
  let booted = false;
  let paused = false; // test/admin freeze (see pause())
  const pausedPeerQueue = [];
  const pauseWaiters = [];
  let bootResolve;
  const bootPromise = new Promise((r) => (bootResolve = r));
  let saving = false;
  async function saveSnapshot() {
    if (!snapFile || saving || !booted) return;
    saving = true;
    try {
      const bytes = region.serialize();
      await fs.promises.mkdir(dataDir, { recursive: true });
      const tmp = `${snapFile}.tmp`;
      await fs.promises.writeFile(tmp, bytes);
      await fs.promises.rename(tmp, snapFile); // atomic replace
    } catch (err) {
      log(`snapshot failed: ${err.message}`);
    } finally {
      saving = false;
    }
  }
  function saveSnapshotSync() {
    if (!snapFile || !booted) return;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(`${snapFile}.tmp`, region.serialize());
    fs.renameSync(`${snapFile}.tmp`, snapFile);
  }
  const snapTimer = snapFile ? setInterval(saveSnapshot, snapshotEvery) : null;

  // ------------------------------------------------- items & rewards
  // WORLD_ID makes capture keys unique per world (a wiped world restarts
  // entity ids; old items must not collide with new organisms).
  const worldId = String(opts.worldId ?? cfg.get('world-id', 'WORLD_ID', 'w0'));
  const metaUrls = opts.metaUrls ?? JSON.parse(cfg.get('meta-urls', 'META_URLS', '[]'));
  const rewardCap = Number(opts.rewardCap ?? cfg.get('reward-cap', 'REWARD_CAP', 3));
  const rewardEvery = Number(opts.rewardEvery ?? cfg.get('reward-every', 'REWARD_EVERY', 60)) * 1000;
  const meta = metaUrls.length ? new MetaClient(metaUrls, { t: 'hello', role: 'shard', id: shardId, secret }, { log }) : null;
  // Once a minute each account earns floor(sqrt(living descendants)) coins
  // per shard (capped): playing well pays a little, farming pays little more.
  // Keys are per (period, shard, account) so a retry never pays twice.
  const rewardTimer =
    meta && rewardCap > 0
      ? setInterval(() => {
          const counts = new Map();
          for (const e of region.local) {
            if (e.dead || !(e.owner > 0) || e.owner >= GUEST_PID_MIN) continue;
            counts.set(e.owner, (counts.get(e.owner) || 0) + 1);
          }
          const entries = [];
          for (const [acct, n] of counts) entries.push([acct, Math.min(rewardCap, Math.floor(Math.sqrt(n)))]);
          if (!entries.length) return;
          const period = Math.floor(Date.now() / rewardEvery);
          const i = meta.pick(shardId % meta.size);
          if (i >= 0) meta.send(i, { t: 'reward', key: `life:${worldId}:${period}:${shardId}`, period: `life:${worldId}:${period}`, entries });
        }, rewardEvery)
      : null;
  // Lineage adoption: a guest who registers or logs in keeps their
  // descendants (owner guest pid -> account id). Entities migrating at that
  // moment are caught by the remap table for a while.
  const ownerRemap = new Map(); // from -> { to, t }
  function remapOwner(e) {
    const r = ownerRemap.get(e.owner);
    if (r) e.owner = r.to;
  }
  function handleAdoptLineage(msg) {
    const from = Number(msg.from);
    const to = Number(msg.to);
    if (!(from >= GUEST_PID_MIN) || !(to > 0) || to >= GUEST_PID_MIN) return;
    ownerRemap.set(from, { to, t: Date.now() });
    for (const [k, v] of ownerRemap) if (Date.now() - v.t > 120000) ownerRemap.delete(k);
    let n = 0;
    for (const chunk of region.chunks.values()) {
      for (const e of chunk.entities) {
        if (e.owner === from) {
          e.owner = to;
          n++;
        }
      }
    }
    for (const e of region.pendingSpawns) if (e.owner === from) e.owner = to;
    if (n) log(`lineage ${from} -> account ${to}: ${n} organisms`);
  }

  // Spawn keys already applied (a gateway may retry a release).
  const spawned = new Map();

  function findEntity(id, x, y) {
    let found = null;
    region.near(x, y, 64, (e) => {
      if (e.id === id && !e.ghost && !e.dead) found = e;
    });
    if (!found) for (const e of region.local) if (e.id === id && !e.dead) found = e;
    return found;
  }

  function handleCapture(ws, msg) {
    const reply = (r) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'capr', reqId: msg.reqId, ...r }));
    if (!game.captureEntity) return reply({ ok: false, code: 'UNSUPPORTED', msg: '这个游戏不支持收集' });
    const x = Number(msg.x);
    const y = Number(msg.y);
    if (!Number.isFinite(x) || !region.ownsPoint(x, y)) return reply({ ok: false, code: 'MOVED', msg: '目标不在这个分片' });
    const e = findEntity(Number(msg.entityId), x, y);
    if (!e) return reply({ ok: false, code: 'GONE', msg: '目标已经不在了' });
    const data = game.captureEntity(region, e, Number(msg.pid));
    if (!data) return reply({ ok: false, code: 'NOT_YOURS', msg: '只能收集你自己谱系的生物' });
    region.kill(e);
    reply({ ok: true, key: `cap:${worldId}:${e.id}`, data });
  }

  function handleSpawn(ws, msg) {
    const reply = (r) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'spawnr', reqId: msg.reqId, ...r }));
    const x = Number(msg.x);
    const y = Number(msg.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !region.ownsPoint(x, y)) return reply({ ok: false, code: 'MOVED' });
    const key = String(msg.key);
    if (spawned.has(key)) return reply({ ok: true, dup: true });
    const e = game.spawnFromItem ? game.spawnFromItem(region, msg.data, x, y, Number(msg.pid)) : null;
    if (!e) return reply({ ok: false, code: 'BAD_ITEM', msg: '这个物品无法放回世界' });
    spawned.set(key, Date.now());
    if (spawned.size > 10000) for (const [k] of spawned) if (spawned.size > 5000) spawned.delete(k);
    reply({ ok: true, id: e.id });
  }

  // ------------------------------------------------------------ gateways
  const gateways = new Map(); // ws -> { id, bytesOut }
  const onlineByGateway = new Map(); // gw id -> { n, t }

  // Binary output to each gateway is queued during a tick and sent as one
  // batch at the end of it (flushGateways).
  function sendGw(ws, data) {
    if (ws.readyState !== 1) return;
    const g = gateways.get(ws);
    if (!g) return;
    if (ws.bufferedAmount > 64 * 1024 * 1024) {
      // A gateway that cannot keep up would desync every chunk it watches;
      // drop it and let it reconnect and resubscribe from keyframes.
      log('dropping slow gateway');
      ws.terminate();
      return;
    }
    if (typeof data === 'string') {
      ws.send(data);
      g.bytesOut += data.length;
      return;
    }
    g.queue.push(data);
    g.bytesOut += data.byteLength;
  }

  function flushGateways() {
    for (const [ws, g] of gateways) {
      if (g.queue.length === 0) continue;
      if (ws.readyState === 1) {
        // Keep individual WebSocket messages to a few MB.
        let part = [];
        let size = 0;
        for (const m of g.queue) {
          part.push(m);
          size += m.byteLength;
          if (size > 4 * 1024 * 1024) {
            ws.send(packBatch(part), { binary: true });
            part = [];
            size = 0;
          }
        }
        if (part.length) ws.send(packBatch(part), { binary: true });
      }
      g.queue = [];
    }
  }

  function refreshUnion(chunk) {
    chunk.subscribers.clear();
    for (const st of chunk.streams) for (const ws of st.subscribers) chunk.subscribers.add(ws);
  }

  function unsub(chunk, tier, ws) {
    const st = chunk.streams[tier];
    if (st.subscribers.delete(ws) && st.subscribers.size === 0) st.lastSent.clear();
    refreshUnion(chunk);
  }

  function unsubscribeAll(ws) {
    for (const chunk of region.chunks.values()) {
      if (!chunk.subscribers.has(ws)) continue;
      for (const st of chunk.streams) unsub(chunk, st.tier, ws);
    }
    for (const [id, m] of pendingSubs) {
      m.delete(ws);
      if (m.size === 0) pendingSubs.delete(id);
    }
  }

  // Subscriptions for chunks we are about to own (map already says so, the
  // chunk handoff is still in flight) or before boot: applied on arrival.
  const pendingSubs = new Map(); // chunkId -> Map(ws -> Set(tier))
  function subscribe(ws, id, tier) {
    const chunk = region.chunks.get(id);
    if (!chunk) {
      if (id < 0 || id >= topo.chunkCount) return;
      let m = pendingSubs.get(id);
      if (!m) pendingSubs.set(id, (m = new Map()));
      let tiers = m.get(ws);
      if (!tiers) m.set(ws, (tiers = new Set()));
      tiers.add(tier);
      return;
    }
    chunk.streams[tier].subscribers.add(ws);
    chunk.streams[tier].forceKey = true;
    chunk.subscribers.add(ws);
  }
  function applyPendingSubs(id) {
    const m = pendingSubs.get(id);
    if (!m) return;
    pendingSubs.delete(id);
    for (const [ws, tiers] of m) {
      if (ws.readyState !== 1 || !gateways.has(ws)) continue;
      for (const tier of tiers) subscribe(ws, id, tier);
    }
  }

  function handleGatewayJson(ws, msg) {
    const tier = msg.tier === 1 ? 1 : 0;
    switch (msg.t) {
      case 'sub':
        for (const id of msg.c || []) subscribe(ws, id, tier);
        break;
      case 'unsub':
        for (const id of msg.c || []) {
          const chunk = region.chunks.get(id);
          if (chunk) unsub(chunk, tier, ws);
          const m = pendingSubs.get(id);
          if (m && m.get(ws)) {
            m.get(ws).delete(tier);
            if (m.get(ws).size === 0) m.delete(ws);
            if (m.size === 0) pendingSubs.delete(id);
          }
        }
        break;
      case 'player':
        for (const p of msg.p || []) {
          region.players.delete(p.pid);
          region.players.set(p.pid, { name: String(p.name).slice(0, 24), rgb: p.rgb >>> 0, hue: +p.hue || 0 });
          if (control) control.notePlayer({ ...p, gw: gateways.get(ws)?.id });
        }
        while (region.players.size > 200000) region.players.delete(region.players.keys().next().value);
        break;
      case 'chat': {
        if (!region.ownsPoint(msg.x, msg.y)) break;
        const chunk = region.chunks.get(topo.chunkAt(msg.x, msg.y));
        chunk.events.push({ kind: EV_CHAT, pid: msg.pid, x: msg.x, y: msg.y, text: String(msg.text).slice(0, 200) });
        // Every chat line also goes to the moderation log on shard 0.
        const entry = { t: 'chatlog', pid: msg.pid, text: String(msg.text).slice(0, 200), x: msg.x, y: msg.y, shard: shardId };
        if (chatLogBudget-- <= 0) break; // log is a sample under floods; chat itself was delivered
        if (control) control.noteChat(entry);
        else {
          const l = peerLinks.get(0);
          if (l && l.open) l.send(JSON.stringify(entry));
        }
        break;
      }
      case 'admin':
        handleAdmin(ws, msg);
        break;
      case 'mapreq':
        if (coordinator && coordinator.ready) ws.send(JSON.stringify(coordinator.mapMessage()));
        break;
      case 'online':
        onlineByGateway.set(msg.gw, { n: msg.n, t: Date.now() });
        break;
      case 'capture':
        handleCapture(ws, msg);
        break;
      case 'spawn':
        handleSpawn(ws, msg);
        break;
      case 'adopt':
        handleAdoptLineage(msg);
        break;
    }
  }

  function handleGatewayBinary(ws, buf) {
    const r = new Reader(buf);
    const type = r.u8();
    const now = Date.now();
    if (type === I_ACTIONS) {
      const n = r.varint();
      for (let i = 0; i < n; i++) {
        const a = { pid: r.varint(), type: r.u8(), x: r.f32(), y: r.f32(), dx: r.f32(), dy: r.f32() };
        if (!region.ownsPoint(a.x, a.y)) continue;
        // Crowd cap: however many players stand on one chunk, it absorbs at
        // most ACTIONS_PER_CHUNK_TICK tool uses per tick (the rest are
        // dropped; per-player cooldowns already applied at the gateway).
        const target = region.chunks.get(topo.chunkAt(a.x, a.y));
        if (target.actionTick !== region.tick) {
          target.actionTick = region.tick;
          target.actionCount = 0;
        }
        if (++target.actionCount > actionsPerChunkTick) {
          droppedActions++;
          continue;
        }
        const player = region.players.get(a.pid);
        if (game.onAction(region, a, player)) {
          const chunk = region.chunks.get(topo.chunkAt(a.x, a.y));
          if (chunk.events.length < 256) {
            chunk.events.push({ kind: EV_ACTION, pid: a.pid, x: a.x, y: a.y, action: a.type, rgb: player ? player.rgb : 0xffffff });
          }
        }
      }
    } else if (type === I_CURSORS) {
      const n = r.varint();
      for (let i = 0; i < n; i++) {
        const pid = r.varint();
        const x = r.f32();
        const y = r.f32();
        const prev = cursorChunk.get(pid);
        if (!Number.isFinite(x) || !region.ownsPoint(x, y)) {
          if (prev !== undefined) {
            const c = region.chunks.get(prev);
            if (c && c.cursors.delete(pid)) c.cursorsDirty = true;
            cursorChunk.delete(pid);
          }
          continue;
        }
        const id = topo.chunkAt(x, y);
        if (prev !== undefined && prev !== id) {
          const c = region.chunks.get(prev);
          if (c && c.cursors.delete(pid)) c.cursorsDirty = true;
        }
        const chunk = region.chunks.get(id);
        chunk.cursors.set(pid, { x, y, t: now });
        chunk.cursorsDirty = true;
        cursorChunk.set(pid, id);
      }
    }
  }
  const cursorChunk = new Map();

  // --------------------------------------------------------- peer shards
  // Migrations are acknowledged: a batch stays "in flight" until the peer
  // says it adopted it, and goes back to the outbox if the link drops first.
  // Batches carry (epoch, seq) so a re-sent batch the peer already adopted
  // is recognised and not duplicated; the epoch changes on every restart.
  const epoch = (Math.random() * 2 ** 32) >>> 0;
  let migSeq = 0;
  const inflight = new Map(); // seq -> { to, list }
  const seenBatches = new Map(); // `${from}:${epoch}` -> Set(seq) (recent)
  const peerLinks = new Map();
  const outbox = new Map(); // neighbour -> Entity[] waiting for the link
  function openPeer(n) {
    const link = new Link(
      topoCfg.shards[n],
      { t: 'hello', role: 'shard', id: shardId, secret },
      {
        log,
        onOpen: () => {
          if (n === 0 && shardId !== 0) link.send(JSON.stringify(myClaim()));
        },
        onMessage: (data, isBinary) => {
          if (isBinary) return;
          try {
            const msg = JSON.parse(data.toString());
            if (msg.t === 'idhave') {
              const removed = region.dropIds(new Set(msg.ids || []));
              if (removed) log(`removed ${removed} restored organism(s) that already live on shard ${n}`);
            } else if (msg.t === 'mack') inflight.delete(msg.seq);
            else if (msg.t === 'xack') xferOut.delete(msg.seq);
            else if (n === 0) onCoordinatorMessage(msg);
          } catch (err) {
            log('bad peer message', err.message);
          }
        },
        onClose: () => {
          requeueInflight(n);
          for (const x of xferOut.values()) if (x.to === n) x.sent = false;
        },
      },
    );
    peerLinks.set(n, link);
    return link;
  }
  function peer(n) {
    return peerLinks.get(n) || openPeer(n);
  }
  function requeueInflight(n) {
    for (const [seq, b] of inflight) {
      if (b.to !== n) continue;
      inflight.delete(seq);
      const q = outbox.get(n);
      if (q) q.push(...b.list);
      else outbox.set(n, [...b.list]);
    }
  }
  let migratedIn = 0;
  let migratedOut = 0;

  // ---------------------------------------------------- ownership / handoff
  // Chunk handoffs use the same (epoch, seq) + ack scheme as migrations: the
  // chunk stays in `xferOut` (re-sent after reconnects) until the receiver
  // acknowledges it, and the receiver ignores duplicates.
  let xferSeq = 0;
  const xferOut = new Map(); // seq -> { to, chunkId, bytes, sent }
  let chunksIn = 0;
  let chunksOut = 0;

  function myClaim() {
    return {
      t: 'claim',
      shard: shardId,
      live: booted,
      version: topo.version,
      owner: booted ? Array.from(topo.owner) : null,
      snap: snap ? { tick: snap.tick, version: snap.version, chunks: [...snap.chunks.keys()] } : null,
    };
  }

  let restoredIds = null;
  let restoredAt = 0;
  const idChecked = new Set();
  // Called every tick until every neighbour has been asked (or 30 s passed).
  function sendIdChecks() {
    if (!restoredIds) return;
    if (Date.now() - restoredAt > 30000) {
      restoredIds = null;
      return;
    }
    for (const n of region.neighbours) {
      if (idChecked.has(n)) continue;
      const l = peer(n);
      if (l.open && l.send(JSON.stringify({ t: 'idcheck', ids: restoredIds }))) idChecked.add(n);
    }
    if (region.neighbours.every((n) => idChecked.has(n))) restoredIds = null;
  }

  function bootRegion() {
    const ids = topo.chunksOf(shardId);
    region.chunks = new Map(ids.map((id) => [id, region.makeChunk(id)]));
    const missing = snap ? region.applySnapshot(snap, ids) : ids;
    if (snap && missing.length < ids.length) {
      // Restored from a snapshot that may be older than the crash: find out
      // which organisms already live elsewhere (see idcheck), and dedupe
      // arrivals meanwhile.
      restoredIds = [];
      for (const c of region.chunks.values()) for (const e of c.entities) restoredIds.push(e.id);
      restoredAt = Date.now();
      region.dedupeUntil = Date.now() + 60000;
    }
    region.initChunks(missing);
    region.recomputeBorders();
    snap = null; // free memory; later claims only need liveness
    booted = true;
    for (const id of region.chunks.keys()) applyPendingSubs(id);
    log(
      `booted with map v${topo.version}: ${region.chunks.size} chunks (${ids.length - missing.length} restored), ` +
        `neighbours [${region.neighbours}], ${region.entityCount()} entities`,
    );
    bootResolve();
  }

  function applyMap(msg) {
    if (!booted) {
      topo.setOwners(msg.owner, msg.version);
      bootRegion();
      return;
    }
    if (msg.version <= topo.version) return;
    const owners = msg.owner.slice();
    // Never let a map take away a chunk we hold (it would orphan it); the
    // coordinator corrects itself from our load reports.
    for (const id of region.chunks.keys()) owners[id] = shardId;
    topo.setOwners(owners, msg.version);
    region.recomputeBorders();
  }

  function applyMapDelta(msg) {
    if (!booted || msg.version <= topo.version) return;
    if (msg.prev !== topo.version) {
      // Missed an update: ask for the whole map.
      if (shardId === 0) applyMap(coordinator.mapMessage());
      else peerLinks.get(0)?.send(JSON.stringify({ t: 'mapreq', shard: shardId }));
      return;
    }
    const owners = Array.from(topo.owner);
    for (const [id, to] of msg.set) owners[id] = to;
    for (const id of region.chunks.keys()) owners[id] = shardId; // never orphan a held chunk
    topo.setOwners(owners, msg.version);
    region.recomputeBorders();
  }

  // Hand chunk `id` (and everything in it) to shard `to`.
  function giveChunk(id, to) {
    const ok = region.chunks.has(id) && region.chunks.size > 1 && to !== shardId;
    if (ok) {
      topo.owner[id] = to;
      const chunk = region.removeChunk(id);
      for (const [pid, cid] of cursorChunk) if (cid === id) cursorChunk.delete(pid);
      const seq = ++xferSeq;
      xferOut.set(seq, { to, chunkId: id, bytes: region.encodeChunkTransfer(chunk, seq, epoch), sent: false });
      sendTransfers();
      chunksOut++;
    }
    const msg = { t: 'moved', chunk: id, from: shardId, to, ok };
    if (shardId === 0) coordinator.onMoved(msg);
    else peer(0).send(JSON.stringify(msg));
  }

  function sendTransfers() {
    for (const x of xferOut.values()) {
      if (x.sent) continue;
      const link = peer(x.to);
      if (link.send(x.bytes)) x.sent = true;
    }
  }

  function receiveChunk(ws, buf) {
    const { from, epoch: e, seq, chunk } = region.decodeChunkTransfer(buf);
    const key = `x${from}:${e}`;
    let seen = seenBatches.get(key);
    if (!seen) seenBatches.set(key, (seen = new Set()));
    if (!seen.has(seq)) {
      seen.add(seq);
      if (!region.chunks.has(chunk.id)) {
        topo.owner[chunk.id] = shardId;
        if (ownerRemap.size) for (const e of chunk.entities) remapOwner(e);
        region.addChunk(chunk);
        chunksIn++;
        applyPendingSubs(chunk.id);
        log(`received chunk ${chunk.id} (${chunk.entities.length} entities) from shard ${from}`);
      }
    }
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'xack', seq }));
  }

  // Messages from the coordinator (shard 0) to this shard.
  function onCoordinatorMessage(msg) {
    if (msg.t === 'map') applyMap(msg);
    else if (msg.t === 'mapd') applyMapDelta(msg);
    else if (msg.t === 'move') giveChunk(msg.chunk, msg.to);
  }

  // Coordinator (shard 0 only).
  const shardSockets = new Map(); // peer shard -> its incoming ws (to reply on)
  const coordinator =
    shardId === 0
      ? new Coordinator({
          topo,
          log,
          opts: {
            balance: (opts.balance ?? cfg.get('balance', 'BALANCE', 'true')) !== 'false' && opts.balance !== false,
            hotMs: Number(opts.hotMs ?? cfg.get('hot-ms', 'HOT_MS', 0.6 * (1000 / tickHz))),
            ratio: Number(opts.balanceRatio ?? cfg.get('balance-ratio', 'BALANCE_RATIO', 0.7)),
            cooldownMs: Number(opts.balanceCooldownMs ?? cfg.get('balance-cooldown-ms', 'BALANCE_COOLDOWN_MS', 1000)),
          },
          send: (shard, msg) => {
            if (shard === 0) onCoordinatorMessage(msg);
            else {
              const ws = shardSockets.get(shard);
              if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
            }
          },
          broadcast: (msg) => {
            const text = JSON.stringify(msg);
            for (const ws of shardSockets.values()) if (ws.readyState === 1) ws.send(text);
            for (const ws of gateways.keys()) if (ws.readyState === 1) ws.send(text);
            onCoordinatorMessage(msg);
          },
        })
      : null;

  function onShardJson(peerShard, ws, msg) {
    if (msg.t === 'idcheck') {
      // A neighbour came back from a snapshot and asks which of its restored
      // organisms we hold: ours are the live copies. Meanwhile its stale
      // copies may still migrate here - dedupe arrivals for a while.
      region.dedupeUntil = Date.now() + 60000;
      const want = new Set(msg.ids || []);
      const have = [];
      for (const c of region.chunks.values()) for (const e of c.entities) if (want.has(e.id)) have.push(e.id);
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'idhave', ids: have }));
      return;
    }
    if (!coordinator) return;
    if (msg.t === 'chatlog') {
      control.noteChat(msg);
    } else if (msg.t === 'claim') {
      shardSockets.set(msg.shard, ws);
      coordinator.addClaim(msg);
    } else if (msg.t === 'mapreq') {
      if (coordinator.ready && ws.readyState === 1) ws.send(JSON.stringify(coordinator.mapMessage()));
    } else if (msg.t === 'load') coordinator.onLoad(msg);
    else if (msg.t === 'moved') coordinator.onMoved(msg);
  }

  // ------------------------------------------------ admin (shard 0 only)
  const control = shardId === 0 ? new Control({ dataDir, log }) : null;

  function sanctionsMessage() {
    return JSON.stringify({ t: 'sanctions', list: control.active() });
  }
  function broadcastToGateways(text) {
    for (const ws of gateways.keys()) if (ws.readyState === 1) ws.send(text);
  }

  // Requests from the admin page, proxied by a gateway: { t:'admin', id, op, args }.
  function handleAdmin(ws, msg) {
    const reply = (ok, body) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'adminr', id: msg.id, ok, ...body }));
    };
    if (!control) return reply(false, { error: 'not the control shard' });
    try {
      const args = msg.args || {};
      switch (msg.op) {
        case 'state': {
          const now = Date.now();
          const chunkEntities = new Array(topo.chunkCount).fill(0);
          const shards = [];
          for (const [sid, l] of coordinator.loads) {
            for (const [id, n] of l.chunks) if (id >= 0 && id < chunkEntities.length) chunkEntities[id] = n;
            shards.push({ shard: sid, tickMs: +l.tickMs.toFixed(2), raw: l.raw, entities: l.entities, chunks: l.chunks.size, age: now - l.t });
          }
          shards.sort((a, b) => a.shard - b.shard);
          let online = 0;
          const gws = [];
          for (const [gw, o] of onlineByGateway) {
            if (now - o.t < 5000) {
              online += o.n;
              gws.push({ gateway: gw, online: o.n });
            }
          }
          return reply(true, {
            result: {
              world: topo.world,
              shardCount: topo.shardCount,
              map: { version: topo.version, owner: Array.from(topo.owner) },
              chunkEntities,
              shards,
              moves: coordinator.moves,
              pending: coordinator.pending,
              balance: coordinator.balance,
              online,
              gateways: gws,
              knownPlayers: control.players.size,
              chat: control.chat.slice(-100).reverse(),
              sanctions: control.active(),
            },
          });
        }
        case 'players':
          return reply(true, { result: control.search(args.q) });
        case 'move':
          return reply(true, { result: { started: coordinator.requestMove(Number(args.chunk), Number(args.to)) } });
        case 'balance':
          coordinator.balance = !!args.on;
          return reply(true, { result: { balance: coordinator.balance } });
        case 'ban':
        case 'mute':
        case 'kick':
        case 'lift': {
          const r = control.apply(msg.op, args);
          if (r.changed) broadcastToGateways(sanctionsMessage());
          if (r.kick.length) broadcastToGateways(JSON.stringify({ t: 'kick', pids: r.kick }));
          return reply(true, { result: r.result });
        }
        default:
          return reply(false, { error: `unknown op ${msg.op}` });
      }
    } catch (err) {
      return reply(false, { error: err.message });
    }
  }

  function loadReport() {
    const chunks = [];
    for (const c of region.chunks.values()) chunks.push([c.id, c.entities.length]);
    return { t: 'load', shard: shardId, tickMs: stats.tickMs, entities: region.entityCount(), chunks };
  }

  function handlePeerBinary(ws, buf) {
    const type = buf[0];
    if (type === I_GHOST) region.applyGhosts(buf);
    else if (type === I_XFER) receiveChunk(ws, buf);
    else if (type === I_MIGRATE) {
      const { from, epoch: e, seq, entities } = region.decodeMigration(buf);
      const key = `${from}:${e}`;
      let seen = seenBatches.get(key);
      if (!seen) seenBatches.set(key, (seen = new Set()));
      if (!seen.has(seq)) {
        seen.add(seq);
        if (seen.size > 4096) seen.delete(seen.values().next().value);
        migratedIn += entities.length;
        if (ownerRemap.size) for (const e of entities) remapOwner(e);
        region.adopt(entities);
      }
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'mack', seq }));
    }
  }

  // ---------------------------------------------------------- web server
  const stats = { tickMs: 0, tickMsMax: 0, tidi: 1, bytesOut: 0 };
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.end('ok');
      return;
    }
    if (req.url === '/metrics') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          shard: shardId,
          tick: region.tick,
          entities: region.entityCount(),
          chunks: region.chunks.size,
          watchedChunks: [...region.chunks.values()].filter((c) => c.subscribers.size > 0).length,
          watchedLo: [...region.chunks.values()].filter((c) => c.streams[1].subscribers.size > 0).length,
          gateways: gateways.size,
          peers: [...peerLinks].map(([id, l]) => ({ id, open: l.open })),
          migratedIn,
          migratedOut,
          chunksIn,
          chunksOut,
          droppedActions,
          mapVersion: topo.version,
          coordinator: coordinator ? { moves: coordinator.moves, pending: coordinator.pending } : undefined,
          ...stats,
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  wss.on('connection', (ws) => {
    let role = null;
    let peerId = -1;
    ws.on('message', (data, isBinary) => {
      try {
        if (role === null) {
          const hello = JSON.parse(data.toString());
          if (hello.t !== 'hello' || !secretEqual(hello.secret, secret)) {
            ws.close(1008, 'bad hello');
            return;
          }
          role = hello.role;
          if (role === 'gateway') {
            gateways.set(ws, { id: hello.id, bytesOut: 0, queue: [] });
            log(`gateway ${hello.id} connected`);
            if (coordinator && coordinator.ready) ws.send(JSON.stringify(coordinator.mapMessage()));
            if (control) ws.send(sanctionsMessage());
          } else if (role === 'shard') {
            peerId = Number(hello.id);
          }
          return;
        }
        if (role === 'gateway') {
          if (isBinary) handleGatewayBinary(ws, data);
          else handleGatewayJson(ws, JSON.parse(data.toString()));
        } else if (role === 'shard') {
          // While frozen (tests/admin), hold peer traffic so the state stays
          // exactly what was last sent to clients.
          if (isBinary && paused) pausedPeerQueue.push([ws, data]);
          else if (isBinary) handlePeerBinary(ws, data);
          else onShardJson(peerId, ws, JSON.parse(data.toString()));
        }
      } catch (err) {
        log('bad message', err.message);
      }
    });
    ws.on('close', () => {
      if (role === 'gateway') {
        unsubscribeAll(ws);
        gateways.delete(ws);
        log('gateway disconnected');
      } else if (role === 'shard' && peerId >= 0) {
        region.dropPeer(peerId);
        if (shardSockets.get(peerId) === ws) shardSockets.delete(peerId);
      }
    });
    ws.on('error', () => {});
  });

  assertClusterSecret({ host, secret, role: `shard ${shardId}` });
  await new Promise((resolve) => server.listen(port, host, resolve));
  log(`listening on ${host}:${port}`);

  // ---------------------------------------------------------------- boot
  // Shard 0 collects claims (up to BOOT_WAIT ms or until every shard has
  // reported) and decides the map; the others wait for it.
  if (coordinator) {
    coordinator.addClaim(myClaim());
    const bootWait = Number(opts.bootWait ?? cfg.get('boot-wait', 'BOOT_WAIT', 6000));
    const t0 = Date.now();
    while (!coordinator.allClaimed() && Date.now() - t0 < bootWait) await new Promise((r) => setTimeout(r, 50));
    coordinator.decideBoot();
  } else {
    peer(0);
    log('waiting for the ownership map from shard 0');
  }
  await bootPromise;
  for (const n of region.neighbours) peer(n);

  // ----------------------------------------------------------- tick loop
  const dt = 1 / tickHz;
  const tickMs = 1000 / tickHz;
  let nextAt = performance.now();
  let ticksThisSecond = 0;
  let secondStart = performance.now();
  let tickMsAcc = 0;
  let stopped = false;

  function broadcastGateways(data) {
    for (const ws of gateways.keys()) sendGw(ws, data);
  }

  function tick() {
    sendIdChecks();
    const t0 = performance.now();
    const emigrants = region.step(dt);

    // Migrations (entities keep their id) and ghosts to every neighbour.
    for (const [to, list] of emigrants) {
      const q = outbox.get(to);
      if (q) q.push(...list);
      else outbox.set(to, list);
    }
    for (const [to, list] of outbox) {
      const link = peerLinks.get(to);
      if (link && link.open && list.length) {
        const seq = ++migSeq;
        if (link.send(region.encodeMigration(list, seq, epoch))) {
          inflight.set(seq, { to, list });
          migratedOut += list.length;
          outbox.delete(to);
        }
      } else if (!link) {
        // Not a neighbour (entity teleported, e.g. by a big stir): open a
        // link on demand.
        openPeer(to);
      } else if (list.length > 20000) {
        list.splice(0, list.length - 20000);
      }
    }
    for (const n of region.neighbours) {
      const link = peer(n);
      if (link.open) link.send(region.encodeGhosts(n));
    }
    if (xferOut.size) sendTransfers();

    const now = Date.now();
    if (region.tick % netEvery === 0) {
      for (const chunk of region.chunks.values()) {
        if (chunk.subscribers.size === 0) {
          if (chunk.cursors.size) chunk.cursors.clear();
          chunk.events.length = 0;
          continue;
        }
        const netTick = region.tick / netEvery;
        for (const st of chunk.streams) {
          if (st.subscribers.size === 0) continue;
          // The low tier runs at 1/loEvery of the rate; its deltas simply
          // span loEvery ticks' worth of movement.
          if (st.tier === 1 && netTick % loEvery !== 0 && !st.forceKey) continue;
          const key = st.forceKey || st.frameNo % (st.tier === 1 ? loKeyEvery : keyEvery) === 0;
          st.forceKey = false;
          const frame = encodeChunkFrame(chunk, chunkSize, key, st);
          for (const ws of st.subscribers) sendGw(ws, frame);
        }
        const ev = encodeEvents(chunk, chunkSize, region.players, now, (region.tick / netEvery) % 2 === 0);
        if (ev) for (const ws of chunk.subscribers) sendGw(ws, ev);
      }
    }
    if (region.tick % fieldEvery === 0) {
      for (const chunk of region.chunks.values()) {
        if (chunk.subscribers.size === 0) continue;
        const f = encodeField(chunk, region.G, region.C, fieldNetRes);
        for (const ws of chunk.subscribers) sendGw(ws, f);
      }
    }
    if (region.tick % summaryEvery === 0 && gateways.size > 0) {
      const sum = region.summarise();
      const w = new Writer(16 + sum.length * 10);
      w.u8(I_SUMMARY).varint(sum.length);
      for (const s of sum) {
        w.varint(s.id).u16(Math.min(65535, s.pop)).u24(s.rgb).u8(Math.min(255, Math.round(s.nutrient * 20)));
      }
      broadcastGateways(w.finish());
      const counts = [...region.lineageCounts()].sort((a, b) => b[1] - a[1]).slice(0, 100);
      let online = undefined;
      if (shardId === 0) {
        online = 0;
        for (const [gw, o] of onlineByGateway) {
          if (now - o.t > 5000) onlineByGateway.delete(gw);
          else online += o.n;
        }
      }
      let cells = 0;
      for (const c of region.chunks.values()) for (const e of c.entities) if (e.kind === 1) cells++;
      broadcastGateways(
        JSON.stringify({
          t: 'lb',
          shard: shardId,
          tick: region.tick,
          tidi: stats.tidi,
          cells,
          entities: region.entityCount(),
          online,
          top: counts.map(([pid, n]) => [pid, n, region.players.get(pid)?.name ?? '?']),
        }),
      );
    }

    flushGateways();
    const took = performance.now() - t0;
    tickMsAcc += took;
    stats.tickMsMax = Math.max(stats.tickMsMax, took);
    ticksThisSecond++;
    const nowP = performance.now();
    if (nowP - secondStart >= 1000) {
      stats.tickMs = +(tickMsAcc / ticksThisSecond).toFixed(2);
      // Time dilation (EVE Online style): when the shard cannot keep up,
      // the simulation slows down uniformly instead of skipping or
      // exploding dt, and clients are told how slow "now" is.
      stats.tidi = +Math.min(1, (ticksThisSecond * tickMs) / (nowP - secondStart)).toFixed(3);
      stats.bytesOut = 0;
      for (const g of gateways.values()) {
        stats.bytesOut += g.bytesOut;
        g.bytesOut = 0;
      }
      ticksThisSecond = 0;
      tickMsAcc = 0;
      stats.tickMsMax = 0;
      secondStart = nowP;
      // Load report -> coordinator, which may rebalance chunk ownership.
      if (coordinator) {
        coordinator.onLoad(loadReport());
        coordinator.tick();
        if (control.prune()) {
          control.save();
          broadcastToGateways(sanctionsMessage()); // something expired
        }
      } else {
        const l = peerLinks.get(0);
        if (l && l.open) l.send(JSON.stringify(loadReport()));
      }
      chatLogBudget = chatLogPerSec;
      // Forget cursor locations whose cursor already expired or was cleared.
      for (const [pid, id] of cursorChunk) {
        const c = region.chunks.get(id);
        if (!c || !c.cursors.has(pid)) cursorChunk.delete(pid);
      }
    }
  }

  function loop() {
    if (stopped) return;
    try {
      if (!paused) tick();
      if (pauseWaiters.length) {
        paused = true;
        for (const r of pauseWaiters.splice(0)) r();
      }
    } catch (err) {
      console.error(`[shard ${shardId}] tick failed`, err);
    }
    nextAt += tickMs;
    const now = performance.now();
    if (now - nextAt > tickMs * 5) nextAt = now; // overloaded: dilate, don't spiral
    setTimeout(loop, Math.max(0, nextAt - now));
  }
  setTimeout(loop, tickMs);

  return {
    region,
    port,
    stats,
    // Freezes the simulation (used by tests to compare clients with truth).
    // afterTick: freeze at the end of the next tick, so that migrants
    // adopted since the last tick have been sent to clients in that tick's
    // frames (an immediate pause can catch them adopted but never framed).
    // Resolves once frozen.
    pause({ afterTick = false } = {}) {
      if (!afterTick || paused) {
        paused = true;
        return Promise.resolve();
      }
      return new Promise((r) => pauseWaiters.push(r));
    },
    resume() {
      paused = false;
      for (const [ws, data] of pausedPeerQueue.splice(0)) handlePeerBinary(ws, data);
    },
    save: saveSnapshotSync,
    coordinator,
    // Test / admin hook (shard 0 only): move a chunk now.
    requestMove(chunk, to) {
      if (!coordinator) throw new Error('only shard 0 coordinates');
      return coordinator.requestMove(chunk, to);
    },
    close() {
      stopped = true;
      if (snapTimer) clearInterval(snapTimer);
      if (rewardTimer) clearInterval(rewardTimer);
      if (meta) meta.close();
      for (const l of peerLinks.values()) l.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close();
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startShard()
    .then((shard) => {
      // Graceful stop (docker stop, launch.js shutdown): save, then exit.
      const stop = () => {
        try {
          shard.save();
        } catch (err) {
          console.error('final snapshot failed', err);
        }
        process.exit(0);
      };
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

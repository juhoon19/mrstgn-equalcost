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
import { I_ACTIONS, I_CURSORS, I_MIGRATE, I_GHOST, I_SUMMARY, EV_ACTION, EV_CHAT, packBatch } from '../shared/protocol.js';
import { Writer } from '../shared/codec.js';
import { Region } from './region.js';
import { Link, readClusterConfig } from './link.js';
import { encodeChunkFrame, encodeField, encodeEvents } from './snapshot.js';
import { loadGame } from './game-loader.js';

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
  const quiet = opts.quiet ?? cfg.get('quiet', 'QUIET', '') === 'true';
  const log = (...a) => {
    if (!quiet) console.log(`[shard ${shardId}]`, ...a);
  };

  const game = opts.game ?? (await loadGame(cfg.game));
  const topo = new Topology(topoCfg.world || {}, topoCfg.shards.length);
  const chunkSize = topo.world.chunkSize;
  const region = new Region({ topo, shardId, game, seed: opts.seed ?? cfg.seed });
  // Persistence: restore the last snapshot if there is a compatible one,
  // otherwise start a fresh world.
  const dataDir = opts.dataDir ?? cfg.get('data-dir', 'DATA_DIR', '');
  const snapshotEvery = Number(opts.snapshotEvery ?? cfg.get('snapshot-every', 'SNAPSHOT_EVERY', 30)) * 1000;
  const snapFile = dataDir ? path.join(dataDir, `shard-${shardId}-of-${topoCfg.shards.length}.bin`) : '';
  let restored = false;
  if (snapFile && fs.existsSync(snapFile)) {
    try {
      restored = region.restore(fs.readFileSync(snapFile));
      log(restored ? `restored ${snapFile} (tick ${region.tick})` : `ignored incompatible ${snapFile}`);
    } catch (err) {
      log(`could not read ${snapFile}: ${err.message}`);
    }
  }
  if (!restored) game.init(region);
  let saving = false;
  async function saveSnapshot() {
    if (!snapFile || saving) return;
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
    if (!snapFile) return;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(`${snapFile}.tmp`, region.serialize());
    fs.renameSync(`${snapFile}.tmp`, snapFile);
  }
  const snapTimer = snapFile ? setInterval(saveSnapshot, snapshotEvery) : null;
  log(`owns ${region.chunks.size} chunks, neighbours [${region.neighbours}], ${region.entityCount()} entities`);

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
  }

  function handleGatewayJson(ws, msg) {
    const tier = msg.tier === 1 ? 1 : 0;
    switch (msg.t) {
      case 'sub':
        for (const id of msg.c || []) {
          const chunk = region.chunks.get(id);
          if (!chunk) continue;
          chunk.streams[tier].subscribers.add(ws);
          chunk.streams[tier].forceKey = true;
          chunk.subscribers.add(ws);
        }
        break;
      case 'unsub':
        for (const id of msg.c || []) {
          const chunk = region.chunks.get(id);
          if (chunk) unsub(chunk, tier, ws);
        }
        break;
      case 'player':
        for (const p of msg.p || []) {
          region.players.delete(p.pid);
          region.players.set(p.pid, { name: String(p.name).slice(0, 24), rgb: p.rgb >>> 0, hue: +p.hue || 0 });
        }
        while (region.players.size > 200000) region.players.delete(region.players.keys().next().value);
        break;
      case 'chat': {
        if (!region.ownsPoint(msg.x, msg.y)) break;
        const chunk = region.chunks.get(topo.chunkAt(msg.x, msg.y));
        chunk.events.push({ kind: EV_CHAT, pid: msg.pid, x: msg.x, y: msg.y, text: String(msg.text).slice(0, 200) });
        break;
      }
      case 'online':
        onlineByGateway.set(msg.gw, { n: msg.n, t: Date.now() });
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
        onMessage: (data, isBinary) => {
          if (isBinary) return;
          try {
            const msg = JSON.parse(data.toString());
            if (msg.t === 'mack') inflight.delete(msg.seq);
          } catch {
            /* ignore */
          }
        },
        onClose: () => requeueInflight(n),
      },
    );
    peerLinks.set(n, link);
    return link;
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
  for (const n of region.neighbours) openPeer(n);
  let migratedIn = 0;
  let migratedOut = 0;

  function handlePeerBinary(ws, buf) {
    const type = buf[0];
    if (type === I_GHOST) region.applyGhosts(buf);
    else if (type === I_MIGRATE) {
      const { from, epoch: e, seq, entities } = region.decodeMigration(buf);
      const key = `${from}:${e}`;
      let seen = seenBatches.get(key);
      if (!seen) seenBatches.set(key, (seen = new Set()));
      if (!seen.has(seq)) {
        seen.add(seq);
        if (seen.size > 4096) seen.delete(seen.values().next().value);
        migratedIn += entities.length;
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
          if (hello.t !== 'hello' || hello.secret !== secret) {
            ws.close(1008, 'bad hello');
            return;
          }
          role = hello.role;
          if (role === 'gateway') {
            gateways.set(ws, { id: hello.id, bytesOut: 0, queue: [] });
            log(`gateway ${hello.id} connected`);
          } else if (role === 'shard') {
            peerId = Number(hello.id);
          }
          return;
        }
        if (role === 'gateway') {
          if (isBinary) handleGatewayBinary(ws, data);
          else handleGatewayJson(ws, JSON.parse(data.toString()));
        } else if (role === 'shard') {
          if (isBinary) handlePeerBinary(ws, data);
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
      }
    });
    ws.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  log(`listening on ${host}:${port}`);

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
      const link = peerLinks.get(n);
      if (link && link.open) link.send(region.encodeGhosts(n));
    }

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
      // Forget cursor locations whose cursor already expired or was cleared.
      for (const [pid, id] of cursorChunk) {
        const c = region.chunks.get(id);
        if (!c || !c.cursors.has(pid)) cursorChunk.delete(pid);
      }
    }
  }

  let paused = false;
  function loop() {
    if (stopped) return;
    try {
      if (!paused) tick();
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
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    save: saveSnapshotSync,
    close() {
      stopped = true;
      if (snapTimer) clearInterval(snapTimer);
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

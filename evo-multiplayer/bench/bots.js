// Headless players for load testing and end-to-end verification.
//
//   node bench/bots.js --url ws://localhost:8080/ws --n 500 --duration 60
//
// Every bot joins, pans a viewport around, moves its cursor, uses tools and
// chats. A fraction (--decode, default 0.2) fully decodes the snapshot stream
// with the same ClientWorld the browser uses and reports protocol errors:
// unknownIds / dupAdds must stay 0; gaps only happen when a bot is resynced.

import WebSocket from 'ws';
import { Topology } from '../src/shared/topology.js';
import {
  ClientWorld,
  S_CHUNK,
  S_FIELD,
  S_EVENTS,
  S_SUMMARY,
  S_PONG,
  S_BATCH,
  ACTIONS,
  unpackBatch,
  encodeView,
  encodeCursor,
  encodeAction,
  encodePing,
  decodeEvents,
} from '../src/shared/protocol.js';
import { Reader } from '../src/shared/codec.js';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const url = arg('url', 'ws://127.0.0.1:8080/ws');
const N = Number(arg('n', 50));
const rampPerSec = Number(arg('ramp', 200));
const duration = Number(arg('duration', 30));
const actRate = Number(arg('act', 0.3)); // tool uses per bot per second
const decodeFrac = Number(arg('decode', 0.2));
const viewW = Number(arg('view-w', 900));
const viewH = Number(arg('view-h', 520));
const quietBots = arg('quiet', 'false') === 'true';
const loFrac = Number(arg('lo', 0)); // share of bots on the 2.5 Hz tier

const totals = {
  connected: 0,
  welcomed: 0,
  closed: 0,
  errors: 0,
  bytes: 0,
  msgs: 0,
  chunkFrames: 0,
  events: 0,
  cursorsSeen: 0,
  chats: 0,
  rtts: [],
  summaries: 0,
  stats: null,
};
const worlds = [];
const byType = {};

class Bot {
  constructor(i) {
    this.i = i;
    this.decode = Math.random() < decodeFrac;
    this.tier = Math.random() < loFrac ? 1 : 0; // fraction of zoomed-out watchers
    this.ws = new WebSocket(url, { perMessageDeflate: false });
    this.ws.binaryType = 'nodebuffer';
    this.ws.on('open', () => {
      totals.connected++;
      this.ws.send(JSON.stringify({ t: 'hello', name: `bot${i}`, hue: Math.random() }));
    });
    this.ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    this.ws.on('close', () => {
      totals.closed++;
      this.stop();
    });
    this.ws.on('error', () => totals.errors++);
    this.timers = [];
  }

  onMessage(data, isBinary) {
    totals.bytes += data.length;
    totals.msgs++;
    if (!isBinary) byType.json = (byType.json || 0) + data.length;
    if (!isBinary) {
      const msg = JSON.parse(data.toString());
      if (msg.t === 'welcome') this.onWelcome(msg);
      else if (msg.t === 'stats') totals.stats = msg;
      return;
    }
    unpackBatch(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), (m) => this.onBinary(m, isBinary));
  }

  onBinary(data) {
    const type = data[0];
    if (data !== undefined) byType['b' + type] = (byType['b' + type] || 0) + data.length;
    const now = performance.now();
    if (type === S_CHUNK) {
      totals.chunkFrames++;
      if (this.world) this.world.applyChunk(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), now);
    } else if (type === S_FIELD) {
      if (this.world) this.world.applyField(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), now);
    } else if (type === S_EVENTS) {
      totals.events++;
      if (this.world) {
        const ev = decodeEvents(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), this.welcome.world, this.welcome.posQuant);
        totals.cursorsSeen += ev.cursors.length;
        for (const e of ev.events) if (e.kind === 1) totals.chats++;
      }
    } else if (type === S_SUMMARY) {
      totals.summaries++;
    } else if (type === S_PONG) {
      const r = new Reader(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      r.u8();
      const sent = r.u32();
      totals.rtts.push((Date.now() % 2 ** 32) - sent);
    }
  }

  onWelcome(msg) {
    totals.welcomed++;
    this.welcome = msg;
    this.topo = new Topology(msg.world, 1);
    if (this.decode) {
      this.world = new ClientWorld(msg.world, msg.posQuant);
      worlds.push(this.world);
    }
    const W = this.topo.width;
    const H = this.topo.height;
    this.x = Math.random() * (W - viewW);
    this.y = Math.random() * (H - viewH);
    this.vx = (Math.random() - 0.5) * 60;
    this.vy = (Math.random() - 0.5) * 60;
    this.sendView();
    const every = (ms, fn) => this.timers.push(setInterval(fn, ms));
    every(250, () => {
      // Drift the camera; bounce at the edges.
      this.x += this.vx * 0.25;
      this.y += this.vy * 0.25;
      if (this.x < 0 || this.x > W - viewW) this.vx = -this.vx;
      if (this.y < 0 || this.y > H - viewH) this.vy = -this.vy;
      this.sendView();
    });
    every(200, () => {
      this.send(encodeCursor(this.x + viewW / 2 + Math.random() * 100, this.y + viewH / 2 + Math.random() * 100));
    });
    if (actRate > 0) {
      every(1000 / actRate, () => {
        const types = [ACTIONS.NUTRIENT, ACTIONS.SEED, ACTIONS.STIR, ACTIONS.SIGNAL];
        const t = types[Math.floor(Math.random() * types.length)];
        this.send(encodeAction(t, this.x + Math.random() * viewW, this.y + Math.random() * viewH, Math.random() - 0.5, Math.random() - 0.5));
      });
    }
    every(2000, () => this.send(encodePing(Date.now() % 2 ** 32)));
    every(15000 + Math.random() * 15000, () => {
      if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'chat', text: `hello from bot ${this.i}` }));
    });
  }

  sendView() {
    this.send(encodeView(this.x, this.y, this.x + viewW, this.y + viewH, this.tier));
  }

  send(buf) {
    if (this.ws.readyState === 1) this.ws.send(buf);
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

const bots = [];
let started = 0;
const rampTimer = setInterval(() => {
  const k = Math.min(N - started, Math.max(1, Math.round(rampPerSec / 10)));
  for (let j = 0; j < k; j++) bots.push(new Bot(started++));
  if (started >= N) clearInterval(rampTimer);
}, 100);

const t0 = Date.now();
let lastBytes = 0;
let lastAt = Date.now();
const report = setInterval(() => {
  const now = Date.now();
  const dt = (now - lastAt) / 1000;
  const bps = (totals.bytes - lastBytes) / dt;
  lastBytes = totals.bytes;
  lastAt = now;
  const rtts = totals.rtts.splice(0).sort((a, b) => a - b);
  const p = (q) => (rtts.length ? rtts[Math.min(rtts.length - 1, Math.floor(q * rtts.length))] : NaN);
  const err = { gaps: 0, unknownIds: 0, dupAdds: 0, frames: 0, entities: 0 };
  for (const w of worlds) {
    err.gaps += w.stats.gaps;
    err.unknownIds += w.stats.unknownIds;
    err.dupAdds += w.stats.dupAdds;
    err.frames += w.stats.frames;
    err.entities += w.entities.size;
  }
  const open = bots.filter((b) => b.ws.readyState === 1).length;
  const s = totals.stats;
  if (!quietBots) {
    console.log(
      `[bots t=${((now - t0) / 1000).toFixed(0)}s] open=${open}/${N} welcomed=${totals.welcomed} closed=${totals.closed} ` +
        `in=${(bps / 1024).toFixed(0)}KB/s (${(bps / 1024 / Math.max(1, open)).toFixed(1)}KB/s/bot) ` +
        `rtt p50=${p(0.5)}ms p95=${p(0.95)}ms p99=${p(0.99)}ms ` +
        `decoded=${worlds.length} ents/decoder=${(err.entities / Math.max(1, worlds.length)).toFixed(0)} ` +
        `gaps=${err.gaps} unknownIds=${err.unknownIds} dupAdds=${err.dupAdds} ` +
        `cursorsSeen=${totals.cursorsSeen} chats=${totals.chats}` +
        (s ? ` | server: online=${s.online} cells=${s.cells} tidi=${s.tidi}` : ''),
    );
  }
}, 5000);

setTimeout(() => {
  clearInterval(report);
  clearInterval(rampTimer);
  const err = { gaps: 0, unknownIds: 0, dupAdds: 0 };
  for (const w of worlds) {
    err.gaps += w.stats.gaps;
    err.unknownIds += w.stats.unknownIds;
    err.dupAdds += w.stats.dupAdds;
  }
  const result = {
    bots: N,
    welcomed: totals.welcomed,
    errors: totals.errors,
    bytesPerBotPerSec: Math.round(totals.bytes / Math.max(1, totals.welcomed) / duration),
    ...err,
  };
  const tot = Object.values(byType).reduce((a, b) => a + b, 0);
  const names = { b1: 'chunk', b2: 'field', b3: 'summary', b4: 'pong', b5: 'events', json: 'json' };
  console.log('[bots] bytes by type: ' + Object.entries(byType).map(([k, v]) => `${names[k] || k}=${((100 * v) / tot).toFixed(1)}%`).join(' '));
  console.log('[bots] result ' + JSON.stringify(result));
  for (const b of bots) {
    b.stop();
    b.ws.terminate();
  }
  setTimeout(() => process.exit(err.unknownIds || err.dupAdds ? 2 : 0), 200);
}, duration * 1000);

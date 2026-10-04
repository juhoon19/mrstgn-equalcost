// Outgoing, self-healing WebSocket link between cluster processes
// (gateway -> shard, shard -> neighbouring shard). The same code runs on
// one machine (localhost) or across machines, so there is one transport to
// debug. Internal links should stay on a private network: the shared secret
// in the hello message is a guard against mistakes, not a security boundary.

import WebSocket from 'ws';
import crypto from 'node:crypto';

export const DEV_SECRET = 'dev-cluster-secret';

// Constant-time secret comparison for the internal hello (avoids leaking the
// secret length / prefix through response timing on an exposed port).
export function secretEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

// Refuse to listen on a public interface while still using the built-in dev
// secret: that combination lets anyone who reaches an internal port act as a
// trusted gateway/shard (mint coins, ban players, move chunks). A clear
// startup error beats a silent full compromise. Loopback-only is fine for
// local dev; ALLOW_DEV_SECRET=1 is the explicit escape hatch.
export function assertClusterSecret({ host, secret, role = 'node' }) {
  if (secret !== DEV_SECRET) return;
  if (process.env.ALLOW_DEV_SECRET === '1') return;
  if (LOOPBACK.has(String(host))) return;
  throw new Error(
    `[${role}] refusing to listen on ${host} with the built-in dev cluster secret. ` +
      'Set CLUSTER_SECRET to a random value (e.g. `openssl rand -hex 16`) on every ' +
      'shard, gateway and meta process, or bind to 127.0.0.1. ' +
      '(ALLOW_DEV_SECRET=1 overrides, for trusted private networks only.)',
  );
}

export class Link {
  constructor(url, hello, { onOpen, onMessage, onClose, log = () => {} } = {}) {
    this.url = url;
    this.hello = hello;
    this.onOpen = onOpen;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.log = log;
    this.ws = null;
    this.open = false;
    this.closed = false;
    this.backoff = 250;
    this.bytesOut = 0;
    this.connect();
  }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    this.ws = ws;
    ws.binaryType = 'nodebuffer';
    ws.on('open', () => {
      this.open = true;
      this.backoff = 250;
      ws.send(JSON.stringify(this.hello));
      this.log(`link up ${this.url}`);
      if (this.onOpen) this.onOpen(this);
    });
    ws.on('message', (data, isBinary) => {
      if (this.onMessage) this.onMessage(data, isBinary, this);
    });
    ws.on('close', () => {
      const was = this.open;
      this.open = false;
      if (was) this.log(`link down ${this.url}`);
      if (was && this.onClose) this.onClose(this);
      if (!this.closed) {
        setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(5000, this.backoff * 2);
      }
    });
    ws.on('error', () => {
      // 'close' follows; reconnect is handled there.
    });
  }

  // Returns false when the socket is not OPEN (ws silently drops data sent
  // while CLOSING). `cb(err)` fires once the data is handed to the kernel or
  // the send fails; it does NOT mean the peer processed it - use app-level
  // acks for anything that must not be lost (see shard migrations).
  send(data, cb) {
    if (!this.open || !this.ws || this.ws.readyState !== 1) return false;
    this.bytesOut += typeof data === 'string' ? data.length : data.byteLength;
    this.ws.send(data, cb);
    return true;
  }

  get buffered() {
    return this.ws ? this.ws.bufferedAmount : 0;
  }

  close() {
    this.closed = true;
    if (this.ws) this.ws.close();
  }
}

// Reads cluster configuration shared by every process from the environment
// (or CLI flags --key value). TOPOLOGY is JSON:
//   {"world":{"chunksX":24,"chunksY":24},"shards":["ws://10.0.0.5:9100", ...]}
export function readClusterConfig() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const next = process.argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[a.slice(2)] = 'true';
      else {
        args[a.slice(2)] = next;
        i++;
      }
    }
  }
  const get = (k, env, def) => args[k] ?? process.env[env] ?? def;
  const topoJson = get('topology', 'TOPOLOGY', null);
  const topology = topoJson
    ? JSON.parse(topoJson)
    : { world: {}, shards: ['ws://127.0.0.1:9100'] };
  return {
    args,
    get,
    topology,
    secret: get('secret', 'CLUSTER_SECRET', 'dev-cluster-secret'),
    game: get('game', 'GAME', 'soup'),
    seed: Number(get('seed', 'SEED', Date.now() % 100000)),
  };
}

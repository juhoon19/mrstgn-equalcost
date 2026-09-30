// Outgoing, self-healing WebSocket link between cluster processes
// (gateway -> shard, shard -> neighbouring shard). The same code runs on
// one machine (localhost) or across machines, so there is one transport to
// debug. Internal links should stay on a private network: the shared secret
// in the hello message is a guard against mistakes, not a security boundary.

import WebSocket from 'ws';

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

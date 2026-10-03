// Connection from a gateway (or shard) to every meta replica: request/reply
// with timeouts, and pushed events. Requests for an account go to its home
// replica; if that one is down, any live replica can serve it (all state is
// in the database), only live delivery waits for the home to come back.

import { Link } from '../server/link.js';
import { homeReplica, replicaForKey } from './methods.js';

export class MetaError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class MetaClient {
  constructor(urls, hello, { log = () => {}, onPush = () => {}, onOpen = () => {}, timeoutMs = 8000 } = {}) {
    this.urls = urls;
    this.pending = new Map();
    this.seq = 0;
    this.timeoutMs = timeoutMs;
    this.links = urls.map(
      (url, i) =>
        new Link(url, hello, {
          log,
          onOpen: () => onOpen(i),
          // The replica went away: its unanswered calls can never be
          // answered - fail them now instead of after the timeout.
          onClose: () => this.failReplica(i),
          onMessage: (data, isBinary) => {
            if (isBinary) return;
            let msg;
            try {
              msg = JSON.parse(data.toString());
            } catch {
              return;
            }
            if (Array.isArray(msg)) for (const m of msg) this.onOne(m, i);
            else this.onOne(msg, i);
          },
        }),
    );
    this.onPush = onPush;
    // Outgoing messages per replica, flushed once per event-loop turn as one
    // frame (order kept). Index i -> [msg].
    this.outQ = urls.map(() => []);
    this.outScheduled = false;
  }

  onOne(msg, i) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'rpcr') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.r);
      else p.reject(new MetaError(msg.code, msg.msg));
    } else if (msg.t === 'push') this.onPush(msg.conn, msg.ev, i);
  }

  failReplica(i) {
    for (const [id, p] of this.pending) {
      if (p.replica !== i) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new MetaError('META_DOWN', '账号服务暂时不可用'));
    }
  }

  queue(i, msg) {
    if (!this.links[i].open) return false;
    this.outQ[i].push(msg);
    if (!this.outScheduled) {
      this.outScheduled = true;
      setImmediate(() => this.flush());
    }
    return true;
  }

  flush() {
    this.outScheduled = false;
    for (let i = 0; i < this.outQ.length; i++) {
      const q = this.outQ[i];
      if (!q.length) continue;
      this.outQ[i] = [];
      if (!this.links[i].send(JSON.stringify(q.length === 1 ? q[0] : q))) {
        // The link dropped in between: fail those calls now, not at timeout.
        for (const m of q) {
          const p = m.t === 'rpc' && this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            clearTimeout(p.timer);
            p.reject(new MetaError('META_DOWN', '账号服务暂时不可用'));
          }
        }
      }
    }
  }

  get size() {
    return this.links.length;
  }

  get enabled() {
    return this.links.length > 0;
  }

  homeOf(acct) {
    return homeReplica(acct, this.links.length);
  }

  // First live replica starting at `want`.
  pick(want) {
    const n = this.links.length;
    for (let k = 0; k < n; k++) {
      const i = (want + k) % n;
      if (this.links[i].open) return i;
    }
    return -1;
  }

  // ctx: { acct, ip, ua, superuser, key } - key routes unauthenticated calls.
  call(m, a = {}, ctx = {}) {
    if (!this.enabled) return Promise.reject(new MetaError('NO_META', '账号服务未启用'));
    const want = ctx.acct ? this.homeOf(ctx.acct) : ctx.key !== undefined ? replicaForKey(ctx.key, this.links.length) : 0;
    const i = this.pick(want);
    if (i < 0) return Promise.reject(new MetaError('META_DOWN', '账号服务暂时不可用'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MetaError('TIMEOUT', '账号服务超时'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, replica: i });
      const ok = this.queue(i, { t: 'rpc', id, m, a, acct: ctx.acct || 0, ip: ctx.ip || '', ua: ctx.ua || '', superuser: !!ctx.superuser });
      if (!ok) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new MetaError('META_DOWN', '账号服务暂时不可用'));
      }
    });
  }

  // Fire-and-forget to a replica (presence, rewards).
  send(replica, msg) {
    return this.links[replica] ? this.queue(replica, msg) : false;
  }

  close() {
    for (const l of this.links) l.close();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new MetaError('CLOSED', 'closed'));
    }
    this.pending.clear();
  }
}

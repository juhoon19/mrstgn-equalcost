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
          onMessage: (data, isBinary) => {
            if (isBinary) return;
            let msg;
            try {
              msg = JSON.parse(data.toString());
            } catch {
              return;
            }
            if (msg.t === 'rpcr') {
              const p = this.pending.get(msg.id);
              if (!p) return;
              this.pending.delete(msg.id);
              clearTimeout(p.timer);
              if (msg.ok) p.resolve(msg.r);
              else p.reject(new MetaError(msg.code, msg.msg));
            } else if (msg.t === 'push') onPush(msg.conn, msg.ev, i);
          },
        }),
    );
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
      this.pending.set(id, { resolve, reject, timer });
      const ok = this.links[i].send(
        JSON.stringify({ t: 'rpc', id, m, a, acct: ctx.acct || 0, ip: ctx.ip || '', ua: ctx.ua || '', superuser: !!ctx.superuser }),
      );
      if (!ok) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new MetaError('META_DOWN', '账号服务暂时不可用'));
      }
    });
  }

  // Fire-and-forget to a replica (presence, rewards).
  send(replica, msg) {
    const l = this.links[replica];
    return l ? l.send(JSON.stringify(msg)) : false;
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

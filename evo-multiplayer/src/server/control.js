// Control plane state for moderation, hosted by shard 0 (next to the
// ownership coordinator). No sockets here: shard-node feeds it and relays
// its decisions to every gateway.
//
//  * player registry: pid -> name, gateway, hashed IP, first/last seen
//    (IPs are HMAC-hashed by the gateway; bans compare hashes, the plain
//    address never leaves the gateway that saw it);
//  * chat log: the last N chat messages from every shard;
//  * sanctions: bans (by pid or IP hash) and mutes, with expiry, persisted
//    to DATA_DIR/bans.json so they survive restarts.

import fs from 'node:fs';
import path from 'node:path';

const MAX_PLAYERS = 200000;
const MAX_CHAT = 500;

export class Control {
  constructor({ dataDir = '', log = () => {}, now = () => Date.now() } = {}) {
    this.log = log;
    this.now = now;
    this.file = dataDir ? path.join(dataDir, 'bans.json') : '';
    this.players = new Map();
    this.chat = [];
    this.sanctions = []; // { id, kind: 'ban'|'mute', pid?, ipHash?, name?, until, reason, at }
    this.nextId = 1;
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.sanctions = Array.isArray(data.sanctions) ? data.sanctions : [];
      this.nextId = Math.max(1, ...this.sanctions.map((s) => s.id + 1));
      this.prune();
      this.log(`loaded ${this.sanctions.length} active sanction(s)`);
    } catch (err) {
      this.log(`could not read ${this.file}: ${err.message}`);
    }
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ sanctions: this.sanctions }, null, 1));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      this.log(`could not write ${this.file}: ${err.message}`);
    }
  }

  // Drops expired sanctions; returns true if anything changed.
  prune() {
    const t = this.now();
    const before = this.sanctions.length;
    this.sanctions = this.sanctions.filter((s) => !s.until || s.until > t);
    return this.sanctions.length !== before;
  }

  notePlayer(p) {
    const t = this.now();
    const prev = this.players.get(p.pid);
    this.players.delete(p.pid);
    this.players.set(p.pid, {
      pid: p.pid,
      name: String(p.name ?? '').slice(0, 24),
      gw: p.gw ?? prev?.gw ?? '',
      ipHash: p.ipHash ?? prev?.ipHash ?? '',
      first: prev?.first ?? t,
      last: t,
    });
    while (this.players.size > MAX_PLAYERS) this.players.delete(this.players.keys().next().value);
  }

  noteChat(c) {
    const p = this.players.get(c.pid);
    this.chat.push({ t: this.now(), pid: c.pid, name: p?.name ?? c.name ?? '?', text: String(c.text).slice(0, 200), x: c.x, y: c.y, shard: c.shard });
    if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT);
  }

  search(q, limit = 50) {
    const needle = String(q ?? '').toLowerCase();
    const out = [];
    const asPid = Number(needle);
    for (const p of [...this.players.values()].reverse()) {
      if (!needle || p.name.toLowerCase().includes(needle) || p.pid === asPid) out.push(p);
      if (out.length >= limit) break;
    }
    return out;
  }

  active() {
    this.prune();
    return this.sanctions;
  }

  // Admin operations. Returns { result, changed, kick: [pids] }.
  apply(op, args = {}) {
    const t = this.now();
    const minutes = Number(args.minutes);
    const until = Number.isFinite(minutes) && minutes > 0 ? t + minutes * 60000 : 0; // 0 = permanent
    const reason = String(args.reason ?? '').slice(0, 200);
    const pid = args.pid !== undefined ? Number(args.pid) : undefined;
    const p = pid !== undefined ? this.players.get(pid) : undefined;
    switch (op) {
      case 'kick':
        if (!Number.isInteger(pid)) throw new Error('pid required');
        return { result: { kicked: pid }, changed: false, kick: [pid] };
      case 'mute':
      case 'ban': {
        if (!Number.isInteger(pid) && !args.ipHash) throw new Error('pid or ipHash required');
        const s = { id: this.nextId++, kind: op, until, reason, at: t };
        if (Number.isInteger(pid)) {
          s.pid = pid;
          s.name = p?.name ?? '';
        }
        // IP bans are opt-in (withIp): behind carrier-grade NAT, a school or
        // a proxy, one address can be many innocent players.
        const ipHash = args.ipHash || (op === 'ban' && args.withIp === true ? p?.ipHash : '');
        if (args.withIp === true && !ipHash) throw new Error('this player\'s address is not known (yet); try again');
        if (ipHash) s.ipHash = ipHash;
        this.sanctions.push(s);
        this.save();
        this.log(`${op} ${s.pid ?? ''} ${s.ipHash ? 'ip:' + s.ipHash : ''} ${until ? minutes + 'min' : 'permanent'} ${reason}`);
        return { result: s, changed: true, kick: op === 'ban' && Number.isInteger(pid) ? [pid] : [] };
      }
      case 'lift': {
        const id = Number(args.id);
        const before = this.sanctions.length;
        this.sanctions = this.sanctions.filter((s) => s.id !== id);
        const changed = this.sanctions.length !== before;
        if (changed) this.save();
        return { result: { lifted: changed }, changed, kick: [] };
      }
      default:
        throw new Error(`unknown op ${op}`);
    }
  }
}

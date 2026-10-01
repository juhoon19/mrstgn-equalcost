// Ownership coordinator: runs inside shard 0.
//
// It owns the chunk -> shard map (with a version number) and changes it in
// two situations:
//
//  * Boot. Every shard reports a "claim": whether it is already running (and
//    with which map) and which chunks its snapshot on disk holds. If anyone
//    is live, the newest live map wins (the coordinator itself restarted).
//    Otherwise (cold start) each chunk goes to the shard with the freshest
//    saved copy of it, and unclaimed chunks follow the static layout.
//
//  * Load balancing. Shards report tick time and per-chunk entity counts every
//    second. When one shard is hot and a neighbour is clearly cooler, the
//    coordinator asks the hot shard to hand one border chunk to it
//    (SpatialOS-style load balancing / Star Citizen "dynamic server meshing",
//    at chunk granularity). One move at a time, so maps never race; the map
//    version is bumped and broadcast when the hot shard confirms.
//
// Transport is injected so this file has no sockets and is unit-testable.

export class Coordinator {
  constructor({ topo, send, broadcast, log = () => {}, opts = {} }) {
    this.topo = topo;
    this.send = send; // (shard, msgObject) -> void
    this.broadcast = broadcast; // (mapMsgObject) -> void (shards + gateways)
    this.log = log;
    this.claims = new Map();
    this.loads = new Map(); // shard -> { tickMs, entities, chunks: Map(id -> n), t }
    this.ready = false;
    this.pending = null; // { chunk, from, to, t }
    this.cooldownUntil = 0;
    this.moves = 0;
    this.balance = opts.balance !== false;
    this.hotMs = opts.hotMs ?? 30; // start balancing above this tick time
    this.ratio = opts.ratio ?? 0.7; // receiver must be below ratio * hot
    this.cooldownMs = opts.cooldownMs ?? 1000;
    this.moveTimeoutMs = opts.moveTimeoutMs ?? 10000;
    // Hysteresis, so noise (JIT warm-up, GC, a burst of births) never makes
    // chunks ping-pong: smoothed load, a warm-up period, a sustained-hot
    // requirement and a per-chunk rest period after each move.
    this.warmupMs = opts.warmupMs ?? 10000;
    this.hotStreakNeeded = opts.hotStreak ?? 3;
    this.chunkRestMs = opts.chunkRestMs ?? 30000;
    this.readyAt = 0;
    this.hotStreak = new Map(); // shard -> consecutive hot ticks
    this.movedAt = new Map(); // chunk -> time of last move
  }

  // Ownership changes are broadcast as deltas (a full map is ~3 bytes per
  // chunk: 50 KB for a 128x128 world, times every shard and gateway, per
  // move). A receiver whose version is not `prev` asks for the full map.
  changeOwners(changes) {
    const owner = Array.from(this.topo.owner);
    for (const [id, to] of changes) owner[id] = to;
    const prev = this.topo.version;
    this.topo.setOwners(owner, prev + 1);
    this.broadcast({ t: 'mapd', prev, version: this.topo.version, set: changes });
  }

  mapMessage() {
    return { t: 'map', version: this.topo.version, owner: Array.from(this.topo.owner) };
  }

  addClaim(claim) {
    this.claims.set(claim.shard, claim);
    if (this.ready && !claim.live) {
      // A shard (re)started while the cluster runs: tell it the current map.
      this.send(claim.shard, this.mapMessage());
    }
  }

  allClaimed() {
    return this.claims.size >= this.topo.shardCount;
  }

  // Decide the boot map from the claims received so far.
  decideBoot() {
    const live = [...this.claims.values()].filter((c) => c.live && Array.isArray(c.owner));
    let owner;
    let version;
    if (live.length) {
      const best = live.reduce((a, b) => (b.version > a.version ? b : a));
      owner = best.owner;
      version = best.version;
      this.log(`boot: adopting live map v${version} from shard ${best.shard}`);
    } else {
      owner = this.topo.defaultOwners();
      const bestTick = new Map(); // chunk -> tick of freshest saved copy
      let maxVersion = 0;
      for (const c of this.claims.values()) {
        if (!c.snap) continue;
        maxVersion = Math.max(maxVersion, c.snap.version || 0);
        for (const id of c.snap.chunks) {
          if (id < 0 || id >= owner.length) continue;
          const prev = bestTick.get(id);
          if (prev === undefined || c.snap.tick > prev) {
            bestTick.set(id, c.snap.tick);
            owner[id] = c.shard;
          }
        }
      }
      version = maxVersion + 1;
      this.log(`boot: cold start, ${bestTick.size} chunk(s) from snapshots, map v${version}`);
    }
    this.topo.setOwners(owner, version);
    this.ready = true;
    this.readyAt = Date.now();
    this.broadcast(this.mapMessage());
  }

  onLoad(load) {
    const chunks = new Map(load.chunks);
    const prev = this.loads.get(load.shard);
    // Exponential moving average of tick time (~3 s memory at 1 report/s).
    const ema = prev ? prev.tickMs * 0.7 + load.tickMs * 0.3 : load.tickMs;
    this.loads.set(load.shard, { tickMs: ema, raw: load.tickMs, entities: load.entities, chunks, t: Date.now() });
    if (!this.ready) return;
    // Self-healing: a shard's report of which chunks it actually holds is
    // the truth. If the map disagrees (e.g. a "moved" confirmation got lost),
    // fix the map - except for the chunk currently being handed over.
    const fixes = [];
    for (const id of chunks.keys()) {
      if (id < 0 || id >= this.topo.owner.length) continue;
      if (this.topo.owner[id] === load.shard) continue;
      if (this.pending && this.pending.chunk === id) continue;
      fixes.push([id, load.shard]);
    }
    if (fixes.length) {
      this.changeOwners(fixes);
      this.log(`map corrected from shard ${load.shard}'s report (v${this.topo.version})`);
    }
  }

  // The hot shard handed the chunk over (or refused: ok === false).
  onMoved({ chunk, from, to, ok }) {
    if (!this.pending || this.pending.chunk !== chunk) return;
    this.pending = null;
    this.cooldownUntil = Date.now() + this.cooldownMs;
    if (ok === false) return;
    this.changeOwners([[chunk, to]]);
    this.moves++;
    this.movedAt.set(chunk, Date.now());
    this.log(`moved chunk ${chunk}: shard ${from} -> ${to} (map v${this.topo.version})`);
  }

  // Ask the owner of `chunk` to hand it to `to`. Returns false if busy.
  requestMove(chunk, to) {
    if (!this.ready || this.pending) return false;
    const from = this.topo.ownerOf(chunk);
    if (from === to) return false;
    this.pending = { chunk, from, to, t: Date.now() };
    this.send(from, { t: 'move', chunk, to });
    return true;
  }

  // Called periodically. Returns the move it started, or null.
  tick(now = Date.now()) {
    if (!this.ready) return null;
    if (this.pending && now - this.pending.t > this.moveTimeoutMs) {
      this.log(`move of chunk ${this.pending.chunk} timed out`);
      this.pending = null;
    }
    if (!this.balance || this.pending || now < this.cooldownUntil) return null;
    if (now - this.readyAt < this.warmupMs) return null;
    const fresh = [...this.loads].filter(([, l]) => now - l.t < 5000);
    if (fresh.length < 2) return null;
    // Sustained heat = the raw per-second reading stayed hot N times in a row
    // (the average alone would keep a single spike "hot" for seconds).
    for (const [s, l] of fresh) this.hotStreak.set(s, l.raw >= this.hotMs ? (this.hotStreak.get(s) || 0) + 1 : 0);
    // Try the hottest shard first; if all its neighbours are equally busy,
    // the next one, so load cascades outward (hotspot -> ring -> beyond).
    const byLoad = fresh.slice().sort((a, b) => b[1].tickMs - a[1].tickMs);
    const loads = new Map(fresh);
    for (const [hot, H] of byLoad) {
      if (H.tickMs < this.hotMs) break;
      if ((this.hotStreak.get(hot) || 0) < this.hotStreakNeeded) continue;
      const plan = this.pickMove(hot, H, loads);
      if (!plan) continue;
      this.requestMove(plan.chunk, plan.to);
      return plan;
    }
    return null;
  }

  // Choose a border chunk of `hot` to give to a cooler neighbour, sized so
  // the move narrows the gap without flipping it.
  pickMove(hot, H, loads) {
    const topo = this.topo;
    const mine = topo.chunksOf(hot);
    if (mine.length <= 1) return null;
    const costPerEntity = H.tickMs / Math.max(1, H.entities);
    let best = null;
    const now = Date.now();
    for (const id of mine) {
      if (now - (this.movedAt.get(id) || -Infinity) < this.chunkRestMs) continue;
      const [cx, cy] = topo.chunkXY(id);
      const adj = new Map(); // neighbour shard -> number of shared edges
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        if (!topo.inBounds(cx + dx, cy + dy)) continue;
        const o = topo.ownerOf(topo.chunkId(cx + dx, cy + dy));
        if (o !== hot) adj.set(o, (adj.get(o) || 0) + 1);
      }
      for (const [to, edges] of adj) {
        const L = loads.get(to);
        if (!L || L.tickMs > H.tickMs * this.ratio) continue;
        const n = H.chunks.get(id) || 0;
        if (n === 0) continue; // moving an empty chunk relieves nothing
        const moved = n * costPerEntity;
        // Don't overshoot: after the move the receiver must still be cooler.
        if (L.tickMs + moved >= H.tickMs - moved) continue;
        // Prefer the coolest receiver first, then big relief and compact
        // shapes (more shared edges).
        const score = (H.tickMs - L.tickMs) + moved * 0.5 + edges * 0.5;
        if (!best || score > best.score) best = { chunk: id, to, score, n };
      }
    }
    return best;
  }
}

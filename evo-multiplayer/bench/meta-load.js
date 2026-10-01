// Load test for the account/social/trading layer through real gateways.
//
//   node bench/meta-load.js --url ws://127.0.0.1:8080/ws --clients 500 --seconds 30
//
// Each client registers (or logs in on re-runs), then loops over a realistic
// mix: DMs to friends, friend requests, wallet and market reads, listings
// and purchases, P2P trade setup. Reports throughput, latency percentiles and
// error codes. Run against `node src/launch.js` with REGISTER_PER_IP_HOUR and
// MAX_PER_IP raised (all bots share one IP).

import WebSocket from 'ws';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const urls = String(args.url || 'ws://127.0.0.1:8080/ws').split(',');
const N = Number(args.clients || 200);
const SECONDS = Number(args.seconds || 20);
const RATE = Number(args.rate || 1); // calls per second per client
const prefix = args.prefix || `lt${Date.now() % 100000}`;

const lat = [];
const errors = new Map();
let ok = 0;
let pushes = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    const c = { ws, pending: new Map(), seq: 0, welcome: null };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'bot', ...hello })));
    ws.on('error', reject);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(data.toString());
      if (m.t === 'welcome') {
        c.welcome = m;
        resolve(c);
      } else if (m.t === 'ev') pushes++;
      else if (m.t === 'rpcr') {
        const p = c.pending.get(m.id);
        c.pending.delete(m.id);
        if (p) p(m);
      }
    });
    c.rpc = (m, a = {}) =>
      new Promise((res) => {
        const id = ++c.seq;
        const t0 = performance.now();
        c.pending.set(id, (r) => {
          const dt = performance.now() - t0;
          if (r.ok) {
            ok++;
            lat.push(dt);
          } else errors.set(r.code, (errors.get(r.code) || 0) + 1);
          res(r);
        });
        ws.send(JSON.stringify({ t: 'rpc', id, m, a }));
      });
  });
}

async function bot(i) {
  const url = urls[i % urls.length];
  const name = `${prefix}_${i}`;
  const g = await connect(url, {});
  let r = await g.rpc('auth.register', { name, password: 'password123' });
  if (!r.ok) r = await g.rpc('auth.login', { name, password: 'password123' });
  g.ws.close();
  if (!r.ok) throw new Error(`${name}: ${r.code}`);
  const c = await connect(url, { session: r.r.token });
  c.id = c.welcome.pid;
  c.name = name;
  return c;
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];

async function main() {
  console.log(`registering ${N} accounts via ${urls.length} gateway(s)…`);
  const t0 = performance.now();
  const bots = [];
  for (let k = 0; k < N; k += 50) bots.push(...(await Promise.all(Array.from({ length: Math.min(50, N - k) }, (_, j) => bot(k + j)))));
  console.log(`  ${N} accounts ready in ${((performance.now() - t0) / 1000).toFixed(1)} s (scrypt hashing dominates)`);
  // Pair everyone with a few friends.
  await Promise.all(bots.map((b, i) => b.rpc('friends.request', { to: bots[(i + 1) % N].id })));
  await Promise.all(bots.map((b, i) => b.rpc('friends.respond', { from: bots[(i - 1 + N) % N].id, accept: true })));
  lat.length = 0;
  ok = 0;
  errors.clear();
  pushes = 0;

  const mix = [
    [30, (b, i) => b.rpc('dm.send', { to: bots[(i + 1) % N].id, text: `hello ${Math.random().toString(36).slice(2, 8)}` })],
    [15, (b) => b.rpc('wallet.get')],
    [15, (b) => b.rpc('market.browse', {})],
    [10, (b) => b.rpc('friends.list')],
    [10, (b) => b.rpc('dm.unread')],
    [5, (b, i) => b.rpc('dm.history', { with: bots[(i + 1) % N].id })],
    [5, (b) => b.rpc('trade.mine')],
    [5, (b, i) => b.rpc('player.find', { name: bots[(i + 7) % N].name })],
    [5, (b, i) => b.rpc('friends.request', { to: pick(bots).id }).then(() => i)],
  ];
  const total = mix.reduce((s, [w]) => s + w, 0);
  const choose = () => {
    let x = Math.random() * total;
    for (const [w, f] of mix) if ((x -= w) < 0) return f;
    return mix[0][1];
  };
  console.log(`running mix for ${SECONDS} s at ${RATE} call/s per client…`);
  const end = performance.now() + SECONDS * 1000;
  const start = performance.now();
  await Promise.all(
    bots.map(async (b, i) => {
      await sleep(Math.random() * 1000);
      while (performance.now() < end) {
        const t = performance.now();
        await choose()(b, i);
        await sleep(Math.max(0, 1000 / RATE - (performance.now() - t)));
      }
    }),
  );
  const secs = (performance.now() - start) / 1000;
  lat.sort((a, b) => a - b);
  const q = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))].toFixed(1) : '-');
  console.log(`\nresults: ${ok} ok calls in ${secs.toFixed(1)} s = ${(ok / secs).toFixed(0)} calls/s, ${pushes} live pushes delivered`);
  console.log(`latency ms  p50 ${q(0.5)}  p90 ${q(0.9)}  p99 ${q(0.99)}  max ${q(1)}`);
  console.log('errors', Object.fromEntries(errors));
  for (const b of bots) b.ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

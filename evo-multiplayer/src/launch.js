// One-machine launcher: N shard processes + M gateway processes that share
// the public port (node:cluster round-robins incoming connections).
//
//   node src/launch.js --shards 4 --gateways 2 --port 8080 --world 24x24
//
// For several machines run shard-node.js / gateway-node.js directly with the
// same TOPOLOGY everywhere (see docs/deploy.md).

import cluster from 'node:cluster';
import { fork } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(name, env, def) {
  const i = process.argv.indexOf('--' + name);
  if (i >= 0) return process.argv[i + 1];
  return process.env[env] ?? def;
}

const cpus = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
const shards = Number(arg('shards', 'SHARDS', Math.max(1, Math.min(4, cpus - 1))));
const gateways = Number(arg('gateways', 'GATEWAYS', Math.max(1, Math.min(4, Math.floor(cpus / 2)))));
const port = Number(arg('port', 'PORT', 8080));
const shardBase = Number(arg('shard-port', 'SHARD_PORT', 9100));
const [chunksX, chunksY] = String(arg('world', 'WORLD', '24x24')).split('x').map(Number);
const game = arg('game', 'GAME', 'soup');
const dataDir = arg('data-dir', 'DATA_DIR', path.resolve(HERE, '../data'));

// Secrets must survive restarts: the world is restored from snapshots, and
// players should keep their identity (and lineage) too. Generated once and
// kept in the data directory unless given explicitly.
function persistentSecrets() {
  const file = path.join(dataDir, 'secrets.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    const s = { cluster: crypto.randomBytes(16).toString('hex'), token: crypto.randomBytes(16).toString('hex') };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(s), { mode: 0o600 });
    return s;
  }
}
const saved = persistentSecrets();
const secret = arg('secret', 'CLUSTER_SECRET', saved.cluster);
const tokenSecret = arg('token-secret', 'TOKEN_SECRET', saved.token);

const topology = JSON.stringify({
  world: { chunksX, chunksY },
  shards: Array.from({ length: shards }, (_, i) => `ws://127.0.0.1:${shardBase + i}`),
});

const env = {
  ...process.env,
  TOPOLOGY: topology,
  CLUSTER_SECRET: secret,
  TOKEN_SECRET: tokenSecret,
  GAME: game,
  DATA_DIR: dataDir,
};

let stopping = false;

function startShard(i) {
  const child = fork(path.join(HERE, 'server/shard-node.js'), [], {
    env: { ...env, SHARD_ID: String(i), PORT: String(shardBase + i), HOST: '127.0.0.1' },
  });
  child.on('exit', (code) => {
    if (stopping) return;
    console.error(`[launch] shard ${i} exited (${code}); restarting`);
    setTimeout(() => (children[i] = startShard(i)), 1000);
  });
  return child;
}

const children = [];
for (let i = 0; i < shards; i++) children.push(startShard(i));

cluster.setupPrimary({ exec: path.join(HERE, 'server/gateway-node.js') });
for (let i = 0; i < gateways; i++) cluster.fork({ ...env, PORT: String(port), HOST: arg('host', 'HOST', '0.0.0.0') });
cluster.on('exit', (worker, code) => {
  if (stopping) return;
  console.error(`[launch] gateway ${worker.process.pid} exited (${code}); restarting`);
  cluster.fork({ ...env, PORT: String(port), HOST: arg('host', 'HOST', '0.0.0.0') });
});

console.log(`[launch] ${shards} shard(s), ${gateways} gateway(s), world ${chunksX}x${chunksY} chunks`);
console.log(`[launch] open http://localhost:${port}  (public: see docs/deploy.md or scripts/tunnel.sh)`);

function shutdown() {
  stopping = true;
  for (const c of children) c.kill('SIGTERM'); // shards save a snapshot first
  for (const w of Object.values(cluster.workers)) w.kill();
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

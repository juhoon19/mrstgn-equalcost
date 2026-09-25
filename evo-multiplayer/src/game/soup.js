// Demo game: a primordial soup on a 2D plane.
//
// Chemistry (per field cell, three channels):
//   N nutrient  - flows in where there is light, diffuses slowly
//   W waste     - excreted by organisms, turned back into N by light
//   S signal    - pheromone organisms can emit and sense, diffuses fast, decays
//
// Biology: organisms are discs with a tiny neural net (9 inputs -> 6 tanh ->
// 4 outputs: thrust x/y, emit signal, eat). They absorb N, pay for size and
// thrust, divide when they have enough energy (children inherit a mutated
// genome) and leave a corpse pellet when they die. Big organisms can eat
// small ones of a different hue. Nothing about "species" is coded: colours
// drift with the genome, so lineages visibly diverge.
//
// This file is the only game-specific code on the server. To host another
// game, implement the same exports (see docs/game-interface.md).

import { ACTIONS } from '../shared/protocol.js';
import { hueToRgb } from '../shared/color.js';

export { hueToRgb };

export const N = 0;
export const W = 1;
export const S = 2;

export const KIND_CELL = 1;
export const KIND_PELLET = 2;

const IN = 9;
const HID = 6;
const OUT = 4;
const W1 = IN * HID;
const W2 = HID * OUT;
const T_SIZE = W1 + W2;
const T_DIV = T_SIZE + 1;
const T_HUE = T_SIZE + 2;
const T_MUT = T_SIZE + 3;
export const GENOME_LEN = T_SIZE + 4;

const P = {
  inflow: 0.35, // N per cell per second at full light
  nutrientCap: 12,
  wasteToNutrient: 0.25,
  uptake: 0.09,
  basal: 0.004, // energy per r^2 per second
  thrustCost: 0.003,
  maxThrust: 45,
  drag: 2.2,
  divideAt: 2.2, // * size^2
  bodyCost: 0.5, // * size^2, paid by a child, returned as a corpse
  maxAge: 150,
  pelletDecay: 0.08,
  preyRatio: 0.72,
  predationGain: 0.7,
  maxCellsPerChunk: 160,
  initialPerChunk: 14,
  brainEvery: 2,
};

export const name = 'soup';
export const fieldDiffusion = [70, 50, 320];
export const fieldDecay = [0.0, 0.01, 0.9];

// Brightness 0..1 at a world point; slowly drifting light patches so the
// best places to live move and populations must follow.
export function light(x, y, t) {
  const a = Math.sin(x / 260 + t * 0.004) * Math.sin(y / 330 - t * 0.003);
  const b = Math.sin((x + y) / 900 + 1.3);
  const v = 0.55 * a + 0.45 * b;
  return v > 0 ? v * v : 0;
}

// A genome that already does something sensible: swim up the nutrient
// gradient, eat, wander a little. Evolution takes it from there.
export function baseGenome(rng, hue) {
  const g = new Float32Array(GENOME_LEN);
  for (let i = 0; i < T_SIZE; i++) g[i] = rng.gauss() * 0.25;
  const w1 = (i, h, v) => (g[i * HID + h] = v);
  const w2 = (h, o, v) => (g[W1 + h * OUT + o] = v);
  w1(0, 0, 2.5); // dN/dx -> h0
  w1(1, 1, 2.5); // dN/dy -> h1
  w2(0, 0, 1.6); // h0 -> thrust x
  w2(1, 1, 1.6); // h1 -> thrust y
  w1(8, 5, 1.0); // bias -> h5
  w2(5, 3, 3.0); // h5 -> eat
  w2(5, 2, -2.0); // h5 -> (don't) emit
  g[T_SIZE] = 4.5 + rng() * 2;
  g[T_DIV] = 1;
  g[T_HUE] = hue;
  g[T_MUT] = 0.05;
  return g;
}

function mutate(parent, rng) {
  const g = parent.slice();
  const m = Math.max(0.005, Math.min(0.3, g[T_MUT]));
  for (let i = 0; i < T_SIZE; i++) if (rng() < 0.2) g[i] += rng.gauss() * m;
  g[T_SIZE] = Math.max(2.5, Math.min(11, g[T_SIZE] + rng.gauss() * m * 2));
  g[T_DIV] = Math.max(0.6, Math.min(2.5, g[T_DIV] + rng.gauss() * m));
  g[T_HUE] = (g[T_HUE] + rng.gauss() * 0.012 + 1) % 1;
  g[T_MUT] = Math.max(0.005, Math.min(0.3, g[T_MUT] * Math.exp(rng.gauss() * 0.1)));
  return g;
}

class CellData {
  constructor(genome) {
    this.genome = genome;
    this.out = new Float32Array(OUT);
    this.maxAge = P.maxAge;
  }
}

function size(e) {
  return e.data.genome[T_SIZE];
}

function makeCell(region, x, y, genome, energy, owner) {
  const s = genome[T_SIZE];
  const e = region.spawn({
    kind: KIND_CELL,
    x,
    y,
    r: s * 0.75,
    rgb: hueToRgb(genome[T_HUE]),
    owner,
    energy,
  });
  e.data = new CellData(genome);
  e.data.maxAge = P.maxAge * (0.8 + region.rng() * 0.4);
  return e;
}

function makePellet(region, x, y, energy, vx = 0, vy = 0) {
  if (energy < 0.3) return null;
  return region.spawn({ kind: KIND_PELLET, x, y, vx, vy, r: 2.2, rgb: 0x8a7f6a, energy });
}

export function init(region) {
  const S0 = region.world.chunkSize;
  for (const chunk of region.chunks.values()) {
    const ox = chunk.cx * S0;
    const oy = chunk.cy * S0;
    // Pre-fill the field so the world starts alive.
    const G = region.G;
    for (let ly = 0; ly < G; ly++) {
      for (let lx = 0; lx < G; lx++) {
        const L = light(ox + (lx + 0.5) * region.fieldCell, oy + (ly + 0.5) * region.fieldCell, 0);
        chunk.field[(ly * G + lx) * region.C + N] = 2 + L * 6;
      }
    }
    for (let i = 0; i < P.initialPerChunk; i++) {
      const hue = region.rng();
      makeCell(region, ox + region.rng() * S0, oy + region.rng() * S0, mutate(baseGenome(region.rng, hue), region.rng), 20, 0);
    }
  }
}

function brain(region, e) {
  const d = e.data;
  const g = d.genome;
  const [gnx, gny] = region.fieldGradient(e.x, e.y, N);
  const [gsx, gsy] = region.fieldGradient(e.x, e.y, S);
  // Nearest other cell within sensing range.
  let best = 1e9;
  let nx = 0;
  let ny = 0;
  let rel = 0;
  const range = 60;
  region.near(e.x, e.y, range, (o) => {
    if (o === e || o.kind !== KIND_CELL) return;
    const dx = o.x - e.x;
    const dy = o.y - e.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < best && d2 < range * range) {
      best = d2;
      nx = dx;
      ny = dy;
      rel = o.r / e.r - 1;
    }
  });
  if (best < 1e9) {
    const dist = Math.sqrt(best) + 1e-6;
    const k = 1 - dist / range;
    nx = (nx / dist) * k;
    ny = (ny / dist) * k;
  }
  const s = size(e);
  const input = [gnx * 4, gny * 4, gsx * 4, gsy * 4, (e.energy / (P.divideAt * s * s)) * 2 - 1, nx, ny, Math.max(-1, Math.min(1, rel)), 1];
  const h = [0, 0, 0, 0, 0, 0];
  for (let j = 0; j < HID; j++) {
    let a = 0;
    for (let i = 0; i < IN; i++) a += input[i] * g[i * HID + j];
    h[j] = Math.tanh(a);
  }
  for (let o = 0; o < OUT; o++) {
    let a = 0;
    for (let j = 0; j < HID; j++) a += h[j] * g[W1 + j * OUT + o];
    d.out[o] = o < 2 ? Math.tanh(a) : 1 / (1 + Math.exp(-a));
  }
}

export function step(region, dt) {
  const cellsPerChunk = new Map();
  for (const chunk of region.chunks.values()) {
    let n = 0;
    for (const e of chunk.entities) if (e.kind === KIND_CELL) n++;
    cellsPerChunk.set(chunk.id, n);
  }
  const tick = region.tick;
  const local = region.local;
  for (let li = 0; li < local.length; li++) {
    const e = local[li];
    if (e.dead) continue;
    if (e.kind === KIND_PELLET) {
      stepPellet(region, e, dt);
      continue;
    }
    const d = e.data;
    if ((tick + e.id) % P.brainEvery === 0) brain(region, e);
    const s = size(e);
    const s2 = s * s;
    const tx = d.out[0] + region.rng.gauss() * 0.15;
    const ty = d.out[1] + region.rng.gauss() * 0.15;
    const emit = d.out[2];
    const eat = d.out[3];

    // Movement: thrust is weaker for bigger bodies.
    const f = P.maxThrust * (5 / s);
    e.vx += tx * f * dt;
    e.vy += ty * f * dt;

    // Soft collisions with cells (local and ghost). Only e is changed.
    let preyTarget = null;
    region.near(e.x, e.y, e.r + 12, (o) => {
      if (o === e) return;
      const dx = e.x - o.x;
      const dy = e.y - o.y;
      const rr = e.r + o.r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr) return;
      if (o.kind === KIND_PELLET) {
        if (eat > 0.5 && !o.ghost && !o.dead) {
          e.energy += o.energy;
          region.kill(o);
        }
        return;
      }
      const dist = Math.sqrt(d2) + 1e-6;
      const push = ((rr - dist) / rr) * 60;
      e.vx += (dx / dist) * push * dt * 10;
      e.vy += (dy / dist) * push * dt * 10;
      if (eat > 0.6 && !o.ghost && !o.dead && o.r < e.r * P.preyRatio) {
        const hd = Math.abs(o.data.genome[T_HUE] - d.genome[T_HUE]);
        if (Math.min(hd, 1 - hd) > 0.08) preyTarget = o;
      }
    });
    if (preyTarget) {
      e.energy += preyTarget.energy * P.predationGain + P.bodyCost * size(preyTarget) ** 2 * 0.5;
      region.kill(preyTarget);
    }

    const damp = Math.max(0, 1 - P.drag * dt);
    e.vx *= damp;
    e.vy *= damp;
    e.x += e.vx * dt;
    e.y += e.vy * dt;

    // Metabolism.
    const avail = region.sampleField(e.x, e.y, N);
    const want = P.uptake * avail * e.r * dt * (0.3 + 0.7 * eat);
    const got = -region.fieldAdd(e.x, e.y, N, -want);
    e.energy += got;
    region.fieldAdd(e.x, e.y, W, got * 0.5);
    let cost = P.basal * s2 * dt + P.thrustCost * (tx * tx + ty * ty) * s2 * dt;
    if (emit > 0.5) {
      region.fieldAdd(e.x, e.y, S, (emit - 0.5) * 4 * dt);
      cost += 0.02 * dt;
    }
    e.energy -= cost;
    e.age += dt;

    const divE = P.divideAt * s2 * d.genome[T_DIV];
    e.level = Math.max(0, Math.min(255, Math.round((e.energy / divE) * 255)));
    e.r = s * (0.6 + 0.4 * Math.min(1, e.energy / divE));

    if (e.energy <= 0 || e.age > d.maxAge) {
      region.kill(e);
      makePellet(region, e.x, e.y, Math.max(0, e.energy) + P.bodyCost * s2, e.vx, e.vy);
      continue;
    }
    if (e.energy > divE && (cellsPerChunk.get(e.chunk) || 0) < P.maxCellsPerChunk) {
      const child = mutate(d.genome, region.rng);
      const cs = child[T_SIZE];
      const childBody = P.bodyCost * cs * cs;
      const half = e.energy / 2;
      if (half > childBody + 1) {
        const ang = region.rng() * Math.PI * 2;
        const off = e.r * 1.2;
        e.energy = half;
        const c = makeCell(region, e.x + Math.cos(ang) * off, e.y + Math.sin(ang) * off, child, half - childBody, e.owner);
        c.vx = e.vx + Math.cos(ang) * 10;
        c.vy = e.vy + Math.sin(ang) * 10;
        cellsPerChunk.set(e.chunk, (cellsPerChunk.get(e.chunk) || 0) + 1);
      }
    }
  }
}

function stepPellet(region, e, dt) {
  const damp = Math.max(0, 1 - 3 * dt);
  e.vx *= damp;
  e.vy *= damp;
  e.x += e.vx * dt;
  e.y += e.vy * dt;
  const loss = e.energy * P.pelletDecay * dt + 0.02 * dt;
  e.energy -= loss;
  region.fieldAdd(e.x, e.y, N, loss);
  e.level = Math.max(0, Math.min(255, Math.round(e.energy * 8)));
  if (e.energy < 0.2) {
    region.fieldAdd(e.x, e.y, N, Math.max(0, e.energy));
    region.kill(e);
  }
}

// Chemistry: light regenerates nutrient and recycles waste.
export function react(region, chunk, dt) {
  const G = region.G;
  const C = region.C;
  const h = region.fieldCell;
  const S0 = region.world.chunkSize;
  const ox = chunk.cx * S0;
  const oy = chunk.cy * S0;
  const f = chunk.field;
  const t = region.time;
  for (let ly = 0; ly < G; ly++) {
    for (let lx = 0; lx < G; lx++) {
      const i = (ly * G + lx) * C;
      const L = light(ox + (lx + 0.5) * h, oy + (ly + 0.5) * h, t);
      const conv = P.wasteToNutrient * L * f[i + W] * dt;
      f[i + W] -= conv;
      const n = f[i + N] + conv;
      f[i + N] = n + P.inflow * L * dt * Math.max(0, 1 - n / P.nutrientCap);
    }
  }
}

// ---------------------------------------------------------------- actions

// action: { pid, type, x, y, dx, dy }; player: { name, rgb, hue } or undefined
export function onAction(region, action, player) {
  const { type, x, y } = action;
  switch (type) {
    case ACTIONS.NUTRIENT:
      region.fieldSplash(x, y, 40, N, 60);
      return true;
    case ACTIONS.SIGNAL:
      region.fieldSplash(x, y, 36, S, 25);
      return true;
    case ACTIONS.SEED: {
      const hue = player && typeof player.hue === 'number' ? player.hue : region.rng();
      const g = mutate(baseGenome(region.rng, hue), region.rng);
      g[T_HUE] = hue;
      makeCell(region, x, y, g, 30, action.pid);
      return true;
    }
    case ACTIONS.STIR: {
      let dx = action.dx;
      let dy = action.dy;
      const len = Math.hypot(dx, dy);
      if (!(len > 0)) return false;
      dx /= len;
      dy /= len;
      const R = 90;
      region.near(x, y, R, (e) => {
        if (e.ghost) return;
        const d = Math.hypot(e.x - x, e.y - y);
        if (d > R) return;
        const k = 80 * (1 - d / R);
        e.vx += dx * k;
        e.vy += dy * k;
      });
      return true;
    }
    default:
      return false;
  }
}

// ------------------------------------------------------ migration payload

export function encodeData(e, w) {
  if (e.kind !== KIND_CELL) {
    w.u8(0);
    return;
  }
  w.u8(1);
  const g = e.data.genome;
  for (let i = 0; i < GENOME_LEN; i++) w.f32(g[i]);
  const o = e.data.out;
  for (let i = 0; i < OUT; i++) w.f32(o[i]);
  w.f32(e.data.maxAge);
}

export function decodeData(e, r) {
  if (r.u8() === 0) return;
  const g = new Float32Array(GENOME_LEN);
  for (let i = 0; i < GENOME_LEN; i++) g[i] = r.f32();
  e.data = new CellData(g);
  for (let i = 0; i < OUT; i++) e.data.out[i] = r.f32();
  e.data.maxAge = r.f32();
}

export const params = P;

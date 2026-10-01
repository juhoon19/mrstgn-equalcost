// Minimal game module: copy this file to start your own game.
//
//   node src/launch.js --game template            (or GAME=./path/to/mygame.js)
//
// World: particles drift in a one-channel "heat" field. Players can drop
// particles (SEED), heat an area (NUTRIENT tool) and push (STIR). Particles
// move up the heat gradient and bounce off each other. That's all - it exists
// to show every hook the network layer calls, with nothing else in the way.
// See docs/game-interface.md for the rules (only mutate local entities,
// make entity.data serialisable).

import { ACTIONS } from '../shared/protocol.js';
import { hueToRgb } from '../shared/color.js';

// One chemical channel per entry. Units: world units^2 per second, 1/second.
export const fieldDiffusion = [120];
export const fieldDecay = [0.05];

const KIND_PARTICLE = 1; // the client draws kind 1 as a filled disc

// Called once per shard at start (not when restoring a snapshot).
export function init(region) {
  const S = region.world.chunkSize;
  for (const chunk of region.chunks.values()) {
    for (let i = 0; i < 10; i++) {
      spawnParticle(region, (chunk.cx + region.rng()) * S, (chunk.cy + region.rng()) * S, 0, region.rng());
    }
  }
}

function spawnParticle(region, x, y, owner, hue) {
  const e = region.spawn({ kind: KIND_PARTICLE, x, y, r: 4, rgb: hueToRgb(hue), owner, energy: 1 });
  e.data = { hue, spin: region.rng() * 2 - 1 }; // anything, as long as encodeData/decodeData round-trip it
  return e;
}

// Called every tick. Iterate region.local (this shard's live entities).
export function step(region, dt) {
  for (const e of region.local) {
    if (e.dead) continue;
    const [gx, gy] = region.fieldGradient(e.x, e.y, 0);
    e.vx += (gx * 400 + e.data.spin * 5) * dt;
    e.vy += (gy * 400 - e.data.spin * 5) * dt;
    // Collisions: neighbours may be ghosts (owned by another shard) - read only.
    region.near(e.x, e.y, e.r * 2 + 2, (o) => {
      if (o === e) return;
      const dx = e.x - o.x;
      const dy = e.y - o.y;
      const d = Math.hypot(dx, dy) + 1e-6;
      const overlap = e.r + o.r - d;
      if (overlap > 0) {
        e.vx += (dx / d) * overlap * 20 * dt; // only change e
        e.vy += (dy / d) * overlap * 20 * dt;
      }
    });
    const damp = Math.max(0, 1 - 1.5 * dt);
    e.vx *= damp;
    e.vy *= damp;
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    e.age += dt;
    e.level = Math.min(255, Math.round(region.sampleField(e.x, e.y, 0) * 20)); // shown as the nucleus size
    if (e.age > 300) region.kill(e);
  }
}

// Optional: chemistry per chunk after diffusion.
export function react(region, chunk, dt) {
  // e.g. a weak constant heat source in every chunk centre
  const G = region.G;
  const i = ((G >> 1) * G + (G >> 1)) * region.C;
  chunk.field[i] += 0.5 * dt;
}

// Player tools. `player` is { name, rgb, hue } (may be undefined briefly).
// Return true when the action did something (clients then see an effect).
export function onAction(region, action, player) {
  switch (action.type) {
    case ACTIONS.SEED:
      spawnParticle(region, action.x, action.y, action.pid, player ? player.hue : region.rng());
      return true;
    case ACTIONS.NUTRIENT:
      region.fieldSplash(action.x, action.y, 40, 0, 30);
      return true;
    case ACTIONS.STIR: {
      const len = Math.hypot(action.dx, action.dy);
      if (!(len > 0)) return false;
      region.near(action.x, action.y, 80, (e) => {
        if (e.ghost) return;
        e.vx += (action.dx / len) * 60;
        e.vy += (action.dy / len) * 60;
      });
      return true;
    }
    default:
      return false;
  }
}

// Optional: inventory items. Return plain JSON from captureEntity (or null
// to refuse); spawnFromItem gets it back (from the database - validate it).
export function captureEntity(region, e, pid) {
  if (e.owner !== pid) return null;
  return { game: 'template', hue: e.data ? e.data.hue : 0 };
}

export function spawnFromItem(region, data, x, y, pid) {
  if (!data || data.game !== 'template' || !Number.isFinite(data.hue)) return null;
  return spawnParticle(region, x, y, pid, ((data.hue % 1) + 1) % 1);
}

// Migration / snapshot payload for entity.data.
export function encodeData(e, w) {
  w.f32(e.data ? e.data.hue : 0).f32(e.data ? e.data.spin : 0);
}

export function decodeData(e, r) {
  e.data = { hue: r.f32(), spin: r.f32() };
}

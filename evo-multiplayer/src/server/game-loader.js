// Loads a game module by name (src/game/<name>.js) or by path.

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REQUIRED = ['init', 'step', 'onAction', 'encodeData', 'decodeData', 'fieldDiffusion', 'fieldDecay'];

export async function loadGame(spec = 'soup') {
  const url = /[\\/]/.test(spec) || spec.endsWith('.js')
    ? pathToFileURL(path.resolve(spec)).href
    : new URL(`../game/${spec}.js`, import.meta.url).href;
  const mod = await import(url);
  const missing = REQUIRED.filter((k) => !(k in mod));
  if (missing.length) throw new Error(`game module ${spec} is missing: ${missing.join(', ')}`);
  return mod;
}

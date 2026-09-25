// Browser client: connects to a gateway, keeps a ClientWorld replica of the
// chunks in view, renders it with Canvas 2D and sends viewport, cursor and
// tool input. Everything protocol-related is imported from /shared so the
// browser, the bots and the server agree byte for byte.

import { Topology } from '/shared/topology.js';
import {
  ClientWorld,
  ClientEntity,
  S_CHUNK,
  S_FIELD,
  S_SUMMARY,
  S_PONG,
  S_EVENTS,
  EV_CHAT,
  EV_ACTION,
  ACTIONS,
  encodeView,
  encodeCursor,
  encodeAction,
  encodePing,
  decodeEvents,
  decodeSummary,
} from '/shared/protocol.js';
import { Reader } from '/shared/codec.js';
import { hueToRgb, rgbToCss } from '/shared/color.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const ctx = canvas.getContext('2d');
const mini = $('minimap');
const mctx = mini.getContext('2d');

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('soup.' + k);
      return v === null ? d : v;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('soup.' + k, v);
    } catch {
      /* private mode */
    }
  },
};

// ------------------------------------------------------------------ state
let ws = null;
let welcome = null;
let topo = null;
let world = null;
let summary = null;
let lastStats = null;
let connected = false;
let reconnectDelay = 500;
const cam = { x: 0, y: 0, zoom: 2 }; // zoom = screen px per world unit
let dpr = Math.min(2, window.devicePixelRatio || 1);
let W = 0;
let H = 0;
let tool = 'pan';
const cooldownUntil = {};
const cursors = new Map(); // chunkId -> [{pid,x,y,rgb,name}]
const effects = []; // {x,y,rgb,t0,kind}
const bubbles = []; // {x,y,text,name,t0}
const fieldImages = new Map(); // chunkId -> { canvas, t }
let bytesIn = 0;
let kbps = 0;
let pingMs = NaN;
let viewDirty = true;
let lastViewSent = 0;
let lastCursorSent = 0;
let pointerWorld = null;

// ------------------------------------------------------------------- join
const nameInput = $('join-name');
const hueInput = $('join-hue');
nameInput.value = store.get('name', '');
hueInput.value = store.get('hue', String(Math.floor(Math.random() * 360)));
function paintSwatch() {
  $('join-swatch').style.background = rgbToCss(hueToRgb(hueInput.value / 360));
}
hueInput.addEventListener('input', paintSwatch);
paintSwatch();
$('join-go').addEventListener('click', join);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') join();
});
if (store.get('joined', '') === '1' && new URLSearchParams(location.search).get('join') !== '0') join();

function join() {
  store.set('name', nameInput.value.trim());
  store.set('hue', hueInput.value);
  store.set('joined', '1');
  $('join').classList.add('hidden');
  connect();
}

// ------------------------------------------------------------- networking
function wsUrl() {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

function connect() {
  setStatus('连接中…');
  ws = new WebSocket(wsUrl());
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        t: 'hello',
        name: store.get('name', ''),
        hue: Number(store.get('hue', 0)) / 360,
        token: store.get('token', ''),
      }),
    );
  };
  ws.onmessage = (ev) => onMessage(ev.data);
  ws.onclose = () => {
    connected = false;
    setStatus('已断开，重连中…');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(8000, reconnectDelay * 2);
  };
  ws.onerror = () => {};
}

function send(buf) {
  if (ws && ws.readyState === 1 && connected) ws.send(buf);
}

function onMessage(data) {
  if (typeof data === 'string') {
    bytesIn += data.length;
    const msg = JSON.parse(data);
    if (msg.t === 'welcome') onWelcome(msg);
    else if (msg.t === 'stats') onStats(msg);
    return;
  }
  bytesIn += data.byteLength;
  const bytes = new Uint8Array(data);
  const now = performance.now();
  switch (bytes[0]) {
    case S_CHUNK:
      world.applyChunk(bytes, now);
      break;
    case S_FIELD: {
      const id = world.applyField(bytes, now);
      fieldImages.delete(id);
      break;
    }
    case S_EVENTS:
      onEvents(decodeEvents(bytes, welcome.world, welcome.posQuant));
      break;
    case S_SUMMARY:
      summary = decodeSummary(bytes);
      break;
    case S_PONG: {
      const r = new Reader(bytes);
      r.u8();
      pingMs = (Math.floor(performance.now()) % 2 ** 32) - r.u32();
      break;
    }
  }
}

function onWelcome(msg) {
  const first = !welcome;
  welcome = msg;
  connected = true;
  reconnectDelay = 500;
  store.set('token', msg.token);
  topo = new Topology(msg.world, 1);
  world = new ClientWorld(msg.world, msg.posQuant);
  ClientEntity.interval = 1000 / msg.netHz;
  fieldImages.clear();
  cursors.clear();
  if (first) {
    const saved = store.get('cam', '');
    if (saved) {
      try {
        Object.assign(cam, JSON.parse(saved));
      } catch {
        /* ignore */
      }
    } else {
      cam.x = topo.width / 2 + (Math.random() - 0.5) * topo.width * 0.5;
      cam.y = topo.height / 2 + (Math.random() - 0.5) * topo.height * 0.5;
    }
  }
  clampCam();
  viewDirty = true;
  setStatus('在线');
}

function onStats(msg) {
  lastStats = msg;
  $('h-online').textContent = msg.online;
  $('h-cells').textContent = msg.cells;
  $('h-tidi').textContent = msg.tidi >= 0.995 ? '正常' : `${Math.round(msg.tidi * 100)}%`;
  const list = $('board-list');
  list.textContent = '';
  let mine = 0;
  for (const [pid, name, n] of msg.top) {
    const li = document.createElement('li');
    if (welcome && pid === welcome.pid) {
      li.className = 'me';
      mine = n;
    }
    const nameSpan = document.createElement('span');
    nameSpan.textContent = name;
    const count = document.createElement('span');
    count.className = 'n';
    count.textContent = n;
    li.append(nameSpan, count);
    list.append(li);
  }
  if (!mine && world) {
    for (const e of world.entities.values()) if (e.kind === 1 && e.owner === welcome.pid) mine++;
  }
  $('h-mine').textContent = mine;
}

function onEvents(ev) {
  cursors.set(ev.chunkId, ev.cursors.filter((c) => !welcome || c.pid !== welcome.pid));
  const now = performance.now();
  for (const e of ev.events) {
    if (e.kind === EV_ACTION) effects.push({ x: e.x, y: e.y, rgb: e.rgb, t0: now, action: e.action });
    else if (e.kind === EV_CHAT) {
      bubbles.push({ x: e.x, y: e.y, text: e.text, name: e.name, t0: now });
      addChatLine(e.name, e.text);
    }
  }
  if (effects.length > 300) effects.splice(0, effects.length - 300);
  if (bubbles.length > 100) bubbles.splice(0, bubbles.length - 100);
}

function setStatus(s) {
  $('h-status').textContent = s;
}

setInterval(() => {
  kbps = (bytesIn * 8) / 1000;
  bytesIn = 0;
  $('h-kbps').textContent = `${kbps.toFixed(0)} kbps`;
  $('h-ping').textContent = Number.isFinite(pingMs) ? `${pingMs} ms` : '–';
  send(encodePing(Math.floor(performance.now()) % 2 ** 32));
  store.set('cam', JSON.stringify(cam));
}, 1000);

// ------------------------------------------------------------ view / camera
function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  viewDirty = true;
}
window.addEventListener('resize', resize);
resize();

function viewRect() {
  const hw = W / 2 / cam.zoom;
  const hh = H / 2 / cam.zoom;
  return [cam.x - hw, cam.y - hh, cam.x + hw, cam.y + hh];
}

function clampCam() {
  if (!topo) return;
  cam.zoom = Math.max(0.05, Math.min(12, cam.zoom));
  cam.x = Math.max(0, Math.min(topo.width, cam.x));
  cam.y = Math.max(0, Math.min(topo.height, cam.y));
}

function toWorld(sx, sy) {
  return [cam.x + (sx - W / 2) / cam.zoom, cam.y + (sy - H / 2) / cam.zoom];
}

function maybeSendView(now) {
  if (!connected || !topo) return;
  if (!viewDirty && now - lastViewSent < 1000) return;
  if (now - lastViewSent < 100) return;
  viewDirty = false;
  lastViewSent = now;
  const [x0, y0, x1, y1] = viewRect();
  send(encodeView(x0, y0, x1, y1));
  // Mirror the gateway's interest set and forget chunks that left it.
  const want = new Set(topo.viewChunks(x0, y0, x1, y1, welcome.viewMargin, welcome.maxChunks) || []);
  for (const id of [...world.chunks.keys()]) if (!want.has(id)) world.dropChunk(id);
  for (const id of [...world.fields.keys()]) if (!want.has(id)) world.fields.delete(id);
  for (const id of [...cursors.keys()]) if (!want.has(id)) cursors.delete(id);
}

// -------------------------------------------------------------------- input
const toolButtons = [...document.querySelectorAll('#tools button[data-tool]')];
function selectTool(t) {
  tool = t;
  for (const b of toolButtons) b.classList.toggle('active', b.dataset.tool === t);
  canvas.style.cursor = t === 'pan' ? 'grab' : 'crosshair';
}
for (const b of toolButtons) {
  b.addEventListener('click', () => selectTool(b.dataset.tool));
  const bar = document.createElement('div');
  bar.className = 'cool';
  b.append(bar);
}
selectTool('nutrient');

const TOOL_ACTION = { nutrient: ACTIONS.NUTRIENT, seed: ACTIONS.SEED, stir: ACTIONS.STIR, signal: ACTIONS.SIGNAL };

function useTool(x, y, dx = 0, dy = 0) {
  const a = TOOL_ACTION[tool];
  if (!a || !welcome) return;
  const now = performance.now();
  if ((cooldownUntil[a] || 0) > now) return;
  cooldownUntil[a] = now + (welcome.cooldowns[a] || 250);
  send(encodeAction(a, x, y, dx, dy));
}

const pointers = new Map();
let drag = null; // { mode: 'pan'|'stir'|'paint', sx, sy, camX, camY, wx, wy }
let pinch = null;

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: cam.zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, camX: cam.x, camY: cam.y };
    drag = null;
    return;
  }
  const [wx, wy] = toWorld(e.clientX, e.clientY);
  const panButton = e.button === 1 || e.button === 2;
  if (tool === 'pan' || panButton) {
    drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, camX: cam.x, camY: cam.y };
    canvas.style.cursor = 'grabbing';
  } else if (tool === 'stir') {
    drag = { mode: 'stir', wx, wy, sx: e.clientX, sy: e.clientY };
  } else {
    drag = { mode: 'paint' };
    useTool(wx, wy);
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const [wx, wy] = toWorld(e.clientX, e.clientY);
  pointerWorld = [wx, wy];
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    cam.zoom = pinch.zoom * (d / pinch.d);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    cam.x = pinch.camX - (mx - pinch.mx) / cam.zoom;
    cam.y = pinch.camY - (my - pinch.my) / cam.zoom;
    clampCam();
    viewDirty = true;
    return;
  }
  if (!drag) return;
  if (drag.mode === 'pan') {
    cam.x = drag.camX - (e.clientX - drag.sx) / cam.zoom;
    cam.y = drag.camY - (e.clientY - drag.sy) / cam.zoom;
    clampCam();
    viewDirty = true;
  } else if (drag.mode === 'paint') {
    useTool(wx, wy);
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (drag && drag.mode === 'stir') {
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    const dx = wx - drag.wx;
    const dy = wy - drag.wy;
    if (Math.hypot(dx, dy) > 2) useTool(drag.wx, drag.wy, dx, dy);
  }
  drag = null;
  canvas.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    const k = Math.exp(-e.deltaY * 0.0015);
    cam.zoom *= k;
    clampCam();
    // Zoom around the pointer.
    cam.x = wx - (e.clientX - W / 2) / cam.zoom;
    cam.y = wy - (e.clientY - H / 2) / cam.zoom;
    clampCam();
    viewDirty = true;
  },
  { passive: false },
);

mini.addEventListener('pointerdown', (e) => {
  if (!topo) return;
  const r = mini.getBoundingClientRect();
  cam.x = ((e.clientX - r.left) / r.width) * topo.width;
  cam.y = ((e.clientY - r.top) / r.height) * topo.height;
  if (cam.zoom < 1) cam.zoom = 1.5;
  clampCam();
  viewDirty = true;
});

const chatForm = $('chatform');
const chatInput = $('chatinput');
function openChat() {
  chatForm.classList.remove('hidden');
  chatInput.focus();
}
$('btn-chat').addEventListener('click', openChat);
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (text && ws && connected) ws.send(JSON.stringify({ t: 'chat', text }));
  chatInput.value = '';
  chatForm.classList.add('hidden');
  chatInput.blur();
});
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    chatForm.classList.add('hidden');
    chatInput.blur();
  }
});

window.addEventListener('keydown', (e) => {
  if (document.activeElement === chatInput || document.activeElement === nameInput) return;
  const keys = { 1: 'pan', 2: 'nutrient', 3: 'seed', 4: 'stir', 5: 'signal' };
  if (keys[e.key]) selectTool(keys[e.key]);
  else if (e.key === 'Enter') {
    e.preventDefault();
    openChat();
  } else if (e.key === '+' || e.key === '=') {
    cam.zoom *= 1.2;
    clampCam();
    viewDirty = true;
  } else if (e.key === '-') {
    cam.zoom /= 1.2;
    clampCam();
    viewDirty = true;
  }
});

function addChatLine(name, text) {
  const log = $('chatlog');
  const div = document.createElement('div');
  const b = document.createElement('b');
  b.textContent = name + '：';
  div.append(b, document.createTextNode(text));
  log.append(div);
  while (log.children.length > 12) log.firstChild.remove();
}

// --------------------------------------------------------------- rendering
function fieldImage(chunkId, f) {
  let img = fieldImages.get(chunkId);
  if (img) return img;
  const res = f.res;
  const C = welcome.world.channels;
  const c = document.createElement('canvas');
  c.width = res;
  c.height = res;
  const g = c.getContext('2d');
  const data = g.createImageData(res, res);
  for (let i = 0; i < res * res; i++) {
    const n = f.data[i * C] / 255; // nutrient
    const w = C > 1 ? f.data[i * C + 1] / 255 : 0; // waste
    const s = C > 2 ? f.data[i * C + 2] / 255 : 0; // signal
    data.data[i * 4] = Math.min(255, 20 + w * 170 + s * 40);
    data.data[i * 4 + 1] = Math.min(255, 26 + n * 150 + s * 60);
    data.data[i * 4 + 2] = Math.min(255, 36 + n * 40 + s * 230);
    data.data[i * 4 + 3] = 255;
  }
  g.putImageData(data, 0, 0);
  img = { canvas: c };
  fieldImages.set(chunkId, img);
  return img;
}

function drawSummary() {
  if (!summary) return;
  const S = welcome.world.chunkSize;
  for (let cy = 0; cy < summary.chunksY; cy++) {
    for (let cx = 0; cx < summary.chunksX; cx++) {
      const i = cy * summary.chunksX + cx;
      const n = summary.nutrient[i] / 255;
      ctx.fillStyle = `rgb(${20 + n * 20},${26 + n * 90},${36 + n * 40})`;
      ctx.fillRect(cx * S, cy * S, S + 0.5, S + 0.5);
      const pop = summary.pop[i];
      if (pop > 0) {
        const a = Math.min(0.85, 0.15 + pop / 120);
        const rgb = summary.rgb[i];
        ctx.fillStyle = `rgba(${rgb >> 16},${(rgb >> 8) & 255},${rgb & 255},${a})`;
        const pad = S * 0.18;
        ctx.fillRect(cx * S + pad, cy * S + pad, S - 2 * pad, S - 2 * pad);
      }
    }
  }
}

function render(now) {
  requestAnimationFrame(render);
  maybeSendView(now);
  if (pointerWorld && connected && now - lastCursorSent > 150) {
    lastCursorSent = now;
    send(encodeCursor(pointerWorld[0], pointerWorld[1]));
  }
  // Cooldown bars.
  for (const b of toolButtons) {
    const a = TOOL_ACTION[b.dataset.tool];
    const bar = b.querySelector('.cool');
    if (!a || !welcome) continue;
    const left = (cooldownUntil[a] || 0) - now;
    bar.style.width = left > 0 ? `${(left / welcome.cooldowns[a]) * 100}%` : '0';
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#070b10';
  ctx.fillRect(0, 0, W, H);
  if (!welcome) return;

  ctx.setTransform(dpr * cam.zoom, 0, 0, dpr * cam.zoom, dpr * (W / 2 - cam.x * cam.zoom), dpr * (H / 2 - cam.y * cam.zoom));
  const S = welcome.world.chunkSize;
  const [x0, y0, x1, y1] = viewRect();
  const detailed = topo.viewChunks(x0, y0, x1, y1, welcome.viewMargin, welcome.maxChunks);

  // World background + LOD.
  ctx.fillStyle = '#0b1118';
  ctx.fillRect(0, 0, topo.width, topo.height);
  if (!detailed) drawSummary();
  else {
    ctx.imageSmoothingEnabled = true;
    for (const id of detailed) {
      const f = world.fields.get(id);
      const cx = id % welcome.world.chunksX;
      const cy = (id - cx) / welcome.world.chunksX;
      if (!f) continue;
      ctx.drawImage(fieldImage(id, f).canvas, cx * S, cy * S, S, S);
    }
  }

  // Chunk grid.
  ctx.lineWidth = 1 / cam.zoom;
  ctx.strokeStyle = 'rgba(160,200,230,0.06)';
  ctx.beginPath();
  for (let gx = Math.max(0, Math.floor(x0 / S)); gx <= Math.min(welcome.world.chunksX, Math.ceil(x1 / S)); gx++) {
    ctx.moveTo(gx * S, Math.max(0, y0));
    ctx.lineTo(gx * S, Math.min(topo.height, y1));
  }
  for (let gy = Math.max(0, Math.floor(y0 / S)); gy <= Math.min(welcome.world.chunksY, Math.ceil(y1 / S)); gy++) {
    ctx.moveTo(Math.max(0, x0), gy * S);
    ctx.lineTo(Math.min(topo.width, x1), gy * S);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(160,200,230,0.35)';
  ctx.strokeRect(0, 0, topo.width, topo.height);

  // Entities.
  if (detailed) {
    const me = welcome.pid;
    const pad = 20;
    for (const e of world.entities.values()) {
      const x = e.renderX(now);
      const y = e.renderY(now);
      if (x < x0 - pad || x > x1 + pad || y < y0 - pad || y > y1 + pad) continue;
      const rgb = e.rgb;
      if (e.kind === 2) {
        ctx.fillStyle = `rgba(170,150,110,${0.35 + (e.level / 255) * 0.5})`;
        ctx.beginPath();
        ctx.arc(x, y, e.r, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.fillStyle = `rgb(${rgb >> 16},${(rgb >> 8) & 255},${rgb & 255})`;
      ctx.beginPath();
      ctx.arc(x, y, e.r, 0, Math.PI * 2);
      ctx.fill();
      if (cam.zoom > 0.9) {
        // Nucleus: size shows energy.
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath();
        ctx.arc(x, y, e.r * (0.2 + 0.4 * (e.level / 255)), 0, Math.PI * 2);
        ctx.fill();
      }
      if (e.owner === me) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(1 / cam.zoom, 1);
        ctx.beginPath();
        ctx.arc(x, y, e.r + 1.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // Tool effects.
  for (let i = effects.length - 1; i >= 0; i--) {
    const fx = effects[i];
    const age = (now - fx.t0) / 1000;
    if (age > 1.2) {
      effects.splice(i, 1);
      continue;
    }
    const rgb = fx.rgb;
    ctx.strokeStyle = `rgba(${rgb >> 16},${(rgb >> 8) & 255},${rgb & 255},${1 - age / 1.2})`;
    ctx.lineWidth = 2 / cam.zoom;
    ctx.beginPath();
    ctx.arc(fx.x, fx.y, 6 + age * 60, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Everything below is drawn in screen space so text stays crisp.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const toScreen = (x, y) => [(x - cam.x) * cam.zoom + W / 2, (y - cam.y) * cam.zoom + H / 2];
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const list of cursors.values()) {
    for (const c of list) {
      const [sx, sy] = toScreen(c.x, c.y);
      if (sx < -50 || sy < -50 || sx > W + 50 || sy > H + 50) continue;
      ctx.fillStyle = rgbToCss(c.rgb);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + 11, sy + 4);
      ctx.lineTo(sx + 4, sy + 11);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(8,12,18,0.7)';
      const tw = ctx.measureText(c.name).width;
      ctx.fillRect(sx + 12, sy + 8, tw + 8, 15);
      ctx.fillStyle = rgbToCss(c.rgb);
      ctx.fillText(c.name, sx + 16, sy + 15.5);
    }
  }
  ctx.font = '12px system-ui, sans-serif';
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    const age = (now - b.t0) / 1000;
    if (age > 7) {
      bubbles.splice(i, 1);
      continue;
    }
    const [sx, sy] = toScreen(b.x, b.y);
    const text = b.text.length > 60 ? b.text.slice(0, 59) + '…' : b.text;
    const tw = ctx.measureText(text).width;
    ctx.globalAlpha = Math.min(1, (7 - age) / 1.5);
    ctx.fillStyle = 'rgba(240,246,250,0.95)';
    ctx.fillRect(sx - tw / 2 - 6, sy - 34 - age * 4, tw + 12, 20);
    ctx.fillStyle = '#0a1016';
    ctx.fillText(text, sx - tw / 2, sy - 24 - age * 4);
    ctx.globalAlpha = 1;
  }
  if (drag && drag.mode === 'stir' && pointerWorld) {
    const [ax, ay] = toScreen(drag.wx, drag.wy);
    const [bx, by] = toScreen(pointerWorld[0], pointerWorld[1]);
    ctx.strokeStyle = 'rgba(120,200,255,0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }

  drawMinimap();
}

function drawMinimap() {
  const w = mini.width;
  const h = mini.height;
  mctx.fillStyle = '#0b1118';
  mctx.fillRect(0, 0, w, h);
  if (!topo) return;
  const sx = w / topo.width;
  const sy = h / topo.height;
  if (summary) {
    const cw = w / summary.chunksX;
    const ch = h / summary.chunksY;
    for (let i = 0; i < summary.pop.length; i++) {
      const cx = i % summary.chunksX;
      const cy = (i - cx) / summary.chunksX;
      const n = summary.nutrient[i] / 255;
      mctx.fillStyle = `rgb(${14 + n * 20},${20 + n * 80},${28 + n * 30})`;
      mctx.fillRect(cx * cw, cy * ch, cw + 0.5, ch + 0.5);
      if (summary.pop[i] > 0) {
        const rgb = summary.rgb[i];
        mctx.fillStyle = `rgba(${rgb >> 16},${(rgb >> 8) & 255},${rgb & 255},${Math.min(0.9, 0.2 + summary.pop[i] / 100)})`;
        mctx.fillRect(cx * cw + cw * 0.2, cy * ch + ch * 0.2, cw * 0.6, ch * 0.6);
      }
    }
  }
  const [x0, y0, x1, y1] = viewRect();
  mctx.strokeStyle = '#ffffff';
  mctx.lineWidth = 1;
  mctx.strokeRect(x0 * sx, y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy);
}

requestAnimationFrame(render);

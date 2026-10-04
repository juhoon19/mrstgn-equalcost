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
  TIER_HI,
  TIER_LO,
  encodeView,
  encodeCursor,
  encodeAction,
  encodePing,
  decodeEvents,
  decodeSummary,
  unpackBatch,
} from '/shared/protocol.js';
import { Reader } from '/shared/codec.js';
import { hueToRgb, rgbToCss } from '/shared/color.js';
import { initSocial } from './social.js';

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

// Credentials (the login session and the signed identity token) are only
// ever sent to the same origin that served this page. Otherwise a crafted
// link (?server=wss://evil/ws) or a zone URL from a hostile server would
// receive the player's session and take over the account. A cross-origin
// server still gets a credential-free guest connection.
function sameOrigin(url) {
  try {
    return new URL(url, location.href).host === location.host;
  } catch {
    return false;
  }
}

function helloMessage(url) {
  const creds = sameOrigin(url);
  return JSON.stringify({
    t: 'hello',
    name: store.get('name', ''),
    hue: Number(store.get('hue', 0)) / 360,
    token: creds ? store.get('token', '') : '',
    session: creds ? store.get('session', '') : '',
  });
}

function connect(url = currentZoneUrl() || wsUrl()) {
  setStatus('连接中…');
  const sock = new WebSocket(url);
  ws = sock;
  sock.binaryType = 'arraybuffer';
  sock.onopen = () => sock.send(helloMessage(url));
  sock.onmessage = (ev) => onMessage(ev.data);
  sock.onclose = (ev) => onActiveClose(sock, ev);
  sock.onerror = () => {};
}

function onActiveClose(sock, ev) {
  if (sock !== ws) return; // an old connection retired by a zone handover
  connected = false;
  if (ev.code === 4003) {
    setStatus('已被封禁');
    addChatLine('系统', '你已被管理员封禁，无法进入。');
    return; // don't hammer the server
  }
  if (ev.code === 4005) {
    // Logged out elsewhere (password changed / "log out everywhere"):
    // continue as a guest.
    store.set('session', '');
    addChatLine('系统', '你的登录已在其他地方失效（改了密码或退出了所有设备），已切换为游客。');
    setTimeout(() => connect(), 500);
    return;
  }
  if (ev.code === 4004) {
    setStatus('已在别处打开');
    addChatLine('系统', '这个账号在另一个页面打开了。刷新本页可以切回来。');
    return;
  }
  if (ev.code === 4001) {
    setStatus('已被踢出');
    addChatLine('系统', '你被管理员踢出，10 秒后自动重连。');
    setTimeout(() => connect(), 10000);
    return;
  }
  setStatus('已断开，重连中…');
  setTimeout(() => connect(), reconnectDelay);
  reconnectDelay = Math.min(8000, reconnectDelay * 2);
}

// ---------------------------------------------------------- zone handover
// With zones, each region of the world is served by its own gateway pool.
// When the camera settles inside another zone, open a connection there,
// let it fill a fresh replica in the background, then swap and close the
// old one: make-before-break, so the picture never goes empty.
let zoneSwitch = null;
let zoneRetryAt = 0;

function zoneUrlFor(z) {
  const u = welcome.zones.urls[z];
  if (/^wss?:\/\//.test(u)) return u;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${u.startsWith('/') ? '' : '/'}${u}`;
}

function currentZoneUrl() {
  return welcome && welcome.zones && welcome.zone >= 0 ? zoneUrlFor(welcome.zone) : null;
}

function checkZone(now) {
  if (!welcome || !welcome.zones || zoneSwitch || now < zoneRetryAt || !connected) return;
  // From the lobby (zone -1) go straight to the right zone; between zones
  // require the camera to be half a chunk inside the new one (hysteresis).
  const want =
    welcome.zone < 0
      ? topo.zoneAt(welcome.zones, cam.x, cam.y)
      : topo.zoneAtStable(welcome.zones, cam.x, cam.y, welcome.world.chunkSize / 2);
  if (want < 0 || want === welcome.zone) return;
  const zurl = zoneUrlFor(want);
  const sock = new WebSocket(zurl);
  sock.binaryType = 'arraybuffer';
  const sw = { ws: sock, zone: want, welcome: null, world: null, t: 0 };
  zoneSwitch = sw;
  sock.onopen = () => sock.send(helloMessage(zurl));
  sock.onmessage = (ev) => {
    if (zoneSwitch !== sw) return;
    if (typeof ev.data === 'string') {
      const m = JSON.parse(ev.data);
      if (m.t === 'welcome') {
        sw.welcome = m;
        sw.world = new ClientWorld(m.world, m.posQuant);
        sw.t = performance.now();
        const [x0, y0, x1, y1] = viewRect();
        sock.send(encodeView(x0, y0, x1, y1, viewTier()));
      }
      return;
    }
    if (!sw.world) return;
    const t = performance.now();
    unpackBatch(new Uint8Array(ev.data), (b) => {
      if (b[0] === S_CHUNK) sw.world.applyChunk(b, t);
      else if (b[0] === S_FIELD) sw.world.applyField(b, t);
    });
    const [x0, y0, x1, y1] = viewRect();
    const want = topo.viewChunks(x0, y0, x1, y1, sw.welcome.viewMargin, viewMaxChunks()) || [];
    let have = 0;
    for (const id of want) if (sw.world.chunks.has(id)) have++;
    if (have >= want.length * 0.9 || t - sw.t > 1500) finishZoneSwitch(sw);
  };
  sock.onclose = (ev) => {
    if (zoneSwitch !== sw) return;
    zoneSwitch = null;
    zoneRetryAt = performance.now() + (ev.code === 4003 ? 1e9 : 3000);
  };
  sock.onerror = () => {};
}

function finishZoneSwitch(sw) {
  const old = ws;
  zoneSwitch = null;
  ws = sw.ws;
  world = sw.world;
  welcome = sw.welcome;
  store.set('token', welcome.token);
  social.onWelcome(welcome);
  ws.onmessage = (ev) => onMessage(ev.data);
  ws.onclose = (ev) => onActiveClose(sw.ws, ev);
  fieldImages.clear();
  cursors.clear();
  viewDirty = true;
  // Calls sent on the old connection (e.g. a registration) still get their
  // replies: keep it open, text only, until they are answered (max 10 s).
  old.onmessage = (ev) => {
    if (typeof ev.data === 'string') onMessage(ev.data);
  };
  const t0 = performance.now();
  const retire = () => {
    if (social.busy() && performance.now() - t0 < 10000) setTimeout(retire, 200);
    else old.close(1000, 'zone handover');
  };
  retire();
  setStatus(`在线 · ${welcome.zone + 1} 区`);
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
    else if (msg.t === 'notice') addChatLine('系统', msg.text);
    else if (msg.t === 'rpcr') social.onRpcReply(msg);
    else if (msg.t === 'ev') social.onEvent(msg.ev);
    return;
  }
  bytesIn += data.byteLength;
  unpackBatch(new Uint8Array(data), onBinary);
}

function onBinary(bytes) {
  const now = performance.now();
  switch (bytes[0]) {
    case S_CHUNK:
      world.applyChunk(bytes, now);
      break;
    case S_FIELD:
      world.applyField(bytes, now);
      // Neighbours' border rings depend on this chunk too: rebuild lazily.
      fieldImages.clear();
      break;
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
  setStatus(msg.zones && msg.zone >= 0 ? `在线 · ${msg.zone + 1} 区` : '在线');
  social.onWelcome(msg);
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

// Zoomed out, organisms are a few pixels wide: watch the 2.5 Hz stream,
// which costs about a third of the bandwidth and allows a wider view.
const LO_ZOOM = 0.9;
function viewTier() {
  return cam.zoom < LO_ZOOM && welcome.maxChunksLo ? TIER_LO : TIER_HI;
}
function viewMaxChunks() {
  return viewTier() === TIER_LO ? welcome.maxChunksLo : welcome.maxChunks;
}

function maybeSendView(now) {
  if (!connected || !topo) return;
  if (!viewDirty && now - lastViewSent < 1000) return;
  if (now - lastViewSent < 100) return;
  viewDirty = false;
  lastViewSent = now;
  const [x0, y0, x1, y1] = viewRect();
  send(encodeView(x0, y0, x1, y1, viewTier()));
  checkZone(now);
  // Mirror the gateway's interest set and forget chunks that left it.
  const want = new Set(topo.viewChunks(x0, y0, x1, y1, welcome.viewMargin, viewMaxChunks()) || []);
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

// Read-only handles for automated UI tests and the browser console.
globalThis.soupDebug = {
  get cam() {
    return cam;
  },
  get world() {
    return world;
  },
  get pid() {
    return welcome && welcome.pid;
  },
  screenOf(x, y) {
    return [(x - cam.x) * cam.zoom + W / 2, (y - cam.y) * cam.zoom + H / 2];
  },
};

// Accounts, inventory, market, trades, friends (public/social.js).
const social = initSocial({
  store,
  send(obj) {
    if (!ws || ws.readyState !== 1 || !connected) return false;
    ws.send(JSON.stringify(obj));
    return true;
  },
  // Log in / out: reconnect with the new session (identity changes).
  relogin() {
    if (ws) {
      ws.onclose = null;
      ws.close(1000, 'relogin');
    }
    connected = false;
    $('join').classList.add('hidden');
    store.set('joined', '1');
    connect();
  },
  nearestOwn(x, y) {
    if (!world || !welcome) return null;
    const R = Math.max(10, 24 / cam.zoom);
    let best = null;
    let bd = R * R;
    for (const e of world.entities.values()) {
      if (e.owner !== welcome.pid) continue;
      const d = (e.x - x) ** 2 + (e.y - y) ** 2;
      if (d < bd + e.r * e.r) {
        bd = d;
        best = e;
      }
    }
    return best;
  },
  setTool: (t) => selectTool(t),
});

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
  } else if (tool === 'capture' || tool === 'release') {
    social.onMapClick(tool, wx, wy);
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
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const keys = { 1: 'pan', 2: 'nutrient', 3: 'seed', 4: 'stir', 5: 'signal', 6: 'capture' };
  if (keys[e.key]) selectTool(keys[e.key]);
  else if (e.key === 'Escape' && tool === 'release') {
    social.cancelRelease();
    selectTool('pan');
  }
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
// Each chunk's field becomes a (res+2)^2 texture whose outer ring is copied
// from the neighbouring chunks, drawn with a half-cell inset so bilinear
// smoothing blends across chunk borders instead of showing seams.
function fieldColor(f, i, out, o) {
  const C = welcome.world.channels;
  const n = f.data[i * C] / 255; // nutrient
  const w = C > 1 ? f.data[i * C + 1] / 255 : 0; // waste
  const s = C > 2 ? f.data[i * C + 2] / 255 : 0; // signal
  out[o] = Math.min(255, 20 + w * 170 + s * 40);
  out[o + 1] = Math.min(255, 26 + n * 150 + s * 60);
  out[o + 2] = Math.min(255, 36 + n * 40 + s * 230);
  out[o + 3] = 255;
}

function fieldImage(chunkId, f) {
  let img = fieldImages.get(chunkId);
  if (img) return img;
  const res = f.res;
  const P = res + 2;
  const X = welcome.world.chunksX;
  const cx = chunkId % X;
  const cy = (chunkId - cx) / X;
  const nb = (dx, dy) => {
    const nx = cx + dx;
    const ny = cy + dy;
    if (nx < 0 || ny < 0 || nx >= X || ny >= welcome.world.chunksY) return null;
    const g = world.fields.get(ny * X + nx);
    return g && g.res === res ? g : null;
  };
  const c = document.createElement('canvas');
  c.width = P;
  c.height = P;
  const g = c.getContext('2d');
  const data = g.createImageData(P, P);
  for (let y = -1; y <= res; y++) {
    for (let x = -1; x <= res; x++) {
      // Which chunk supplies this padded cell, and which of its cells.
      const dx = x < 0 ? -1 : x >= res ? 1 : 0;
      const dy = y < 0 ? -1 : y >= res ? 1 : 0;
      let src = dx || dy ? nb(dx, dy) : f;
      let sx = x - dx * res;
      let sy = y - dy * res;
      if (!src) {
        // No neighbour data (world edge / not loaded): clamp to own edge.
        src = f;
        sx = Math.min(res - 1, Math.max(0, x));
        sy = Math.min(res - 1, Math.max(0, y));
      }
      fieldColor(src, sy * res + sx, data.data, ((y + 1) * P + x + 1) * 4);
    }
  }
  g.putImageData(data, 0, 0);
  img = { canvas: c, res };
  fieldImages.set(chunkId, img);
  return img;
}

// The world overview (S_SUMMARY, every 2-6 s) is painted once per update
// into small offscreen images, which every frame just scales into place:
// redrawing thousands of rectangles 60 times a second cost several ms.
const SUMMARY_PX = 10; // offscreen pixels per summary cell
const summaryCache = { src: null, main: null, mini: null };
function paintSummary(palette) {
  const c = document.createElement('canvas');
  c.width = summary.cols * SUMMARY_PX;
  c.height = summary.rows * SUMMARY_PX;
  const g = c.getContext('2d');
  const per = summary.bw * summary.bh; // chunks per cell
  const K = SUMMARY_PX;
  const inset = Math.round(K * 0.2);
  for (let r = 0; r < summary.rows; r++) {
    for (let q = 0; q < summary.cols; q++) {
      const i = r * summary.cols + q;
      const n = summary.nutrient[i] / 255;
      g.fillStyle = palette.ground(n);
      g.fillRect(q * K, r * K, K, K);
      const pop = summary.pop[i] / per;
      if (pop > 0.5) {
        const rgb = summary.rgb[i];
        g.fillStyle = `rgba(${rgb >> 16},${(rgb >> 8) & 255},${rgb & 255},${palette.alpha(pop)})`;
        g.fillRect(q * K + inset, r * K + inset, K - 2 * inset, K - 2 * inset);
      }
    }
  }
  return c;
}
const MAIN_PALETTE = {
  ground: (n) => `rgb(${20 + n * 20},${26 + n * 90},${36 + n * 40})`,
  alpha: (pop) => Math.min(0.85, 0.15 + pop / 120),
};
const MINI_PALETTE = {
  ground: (n) => `rgb(${14 + n * 20},${20 + n * 80},${28 + n * 30})`,
  alpha: (pop) => Math.min(0.9, 0.2 + pop / 100),
};
function summaryImages() {
  if (summaryCache.src !== summary) {
    summaryCache.src = summary;
    summaryCache.main = paintSummary(MAIN_PALETTE);
    summaryCache.mini = paintSummary(MINI_PALETTE);
  }
  return summaryCache;
}

function drawSummary() {
  if (!summary) return;
  const S = welcome.world.chunkSize;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(summaryImages().main, 0, 0, summary.cols * S * summary.bw, summary.rows * S * summary.bh);
  ctx.imageSmoothingEnabled = true;
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
  const detailed = topo.viewChunks(x0, y0, x1, y1, welcome.viewMargin, viewMaxChunks());

  // World background + LOD.
  ctx.fillStyle = '#0b1118';
  ctx.fillRect(0, 0, topo.width, topo.height);
  if (!detailed) drawSummary();
  else {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low'; // 'high' (bicubic) made zoomed-in frames 4x slower in software canvas
    for (const id of detailed) {
      const f = world.fields.get(id);
      const cx = id % welcome.world.chunksX;
      const cy = (id - cx) / welcome.world.chunksX;
      if (!f) continue;
      const img = fieldImage(id, f);
      // Source rect insets by half a cell so the border ring only feeds the blend.
      ctx.drawImage(img.canvas, 0.5, 0.5, img.res + 1, img.res + 1, cx * S - S / (2 * img.res), cy * S - S / (2 * img.res), S + S / img.res, S + S / img.res);
    }
  }

  // Chunk grid.
  ctx.lineWidth = 1 / cam.zoom;
  ctx.strokeStyle = 'rgba(160,200,230,0.035)';
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
    // Cells may overhang the world edge when the grid does not divide evenly.
    const cw = (w * summary.bw * welcome.world.chunkSize) / topo.width;
    const ch = (h * summary.bh * welcome.world.chunkSize) / topo.height;
    mctx.imageSmoothingEnabled = false;
    mctx.drawImage(summaryImages().mini, 0, 0, summary.cols * cw, summary.rows * ch);
  }
  const [x0, y0, x1, y1] = viewRect();
  mctx.strokeStyle = '#ffffff';
  mctx.lineWidth = 1;
  mctx.strokeRect(x0 * sx, y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy);
}

requestAnimationFrame(render);

// Ops console: polls /admin/api/state and renders the cluster; moderation
// actions POST to /admin/api/<op>. All requests carry the admin token as a
// Bearer header; the token lives only in sessionStorage.

const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem('adminToken') || '';
let state = null;
let timer = null;

async function api(op, { method = 'GET', body, q } = {}) {
  const url = `/admin/api/${op}` + (q !== undefined ? `?q=${encodeURIComponent(q)}` : '');
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

function showApp(on) {
  $('login').hidden = on;
  $('app').hidden = !on;
}

async function refresh() {
  try {
    state = await api('state');
    $('status').textContent = `已连接 · ${new Date().toLocaleTimeString()}`;
    $('status').className = 'muted';
    render();
  } catch (err) {
    if (err.status === 401) {
      logout('口令错误');
      return;
    }
    $('status').textContent = `错误：${err.message}`;
    $('status').className = 'err';
  }
}

function start() {
  showApp(true);
  refresh();
  clearInterval(timer);
  timer = setInterval(refresh, 2000);
}

function logout(msg = '') {
  clearInterval(timer);
  token = '';
  sessionStorage.removeItem('adminToken');
  showApp(false);
  $('login-err').textContent = msg;
  $('status').textContent = '未登录';
}

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  token = $('token').value.trim();
  sessionStorage.setItem('adminToken', token);
  start();
});
$('logout').addEventListener('click', () => logout());

// ------------------------------------------------------------ rendering
const SHARD_HUES = [150, 210, 30, 280, 0, 90, 330, 180, 250, 60, 120, 300];
const shardColor = (s, light = 55) => `hsl(${SHARD_HUES[s % SHARD_HUES.length]} 60% ${light}%)`;

function td(text, cls) {
  const el = document.createElement('td');
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

function actions(pid, name) {
  const cell = document.createElement('td');
  cell.className = 'row-actions';
  const add = (label, fn, cls) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', fn);
    cell.append(b, ' ');
  };
  add('禁言10分', () => act('mute', { pid, minutes: 10 }, `禁言 ${name} 10 分钟？`));
  add('踢出', () => act('kick', { pid }, `踢出 ${name}？`));
  add(
    '封禁1天',
    () => {
      const reason = prompt(`封禁 ${name} 1 天。原因：`, '');
      if (reason !== null) act('ban', { pid, minutes: 1440, reason }, null);
    },
    'bad',
  );
  add(
    '封禁+IP',
    () => {
      const reason = prompt(
        `封禁 ${name} 以及其 IP 1 天。\n注意：同一 IP 后面可能有很多无辜玩家（手机网络、学校、公司）。原因：`,
        '',
      );
      if (reason !== null) act('ban', { pid, minutes: 1440, reason, withIp: true }, null);
    },
    'bad',
  );
  return cell;
}

async function act(op, body, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  try {
    await api(op, { method: 'POST', body });
    refresh();
  } catch (err) {
    alert(`失败：${err.message}`);
  }
}

const ago = (ms) => (ms < 1500 ? '刚刚' : `${Math.round(ms / 1000)} 秒前`);
const fmtTime = (t) => new Date(t).toLocaleTimeString();

function render() {
  const s = state;
  const ents = s.shards.reduce((a, b) => a + b.entities, 0);
  $('k-online').textContent = s.online;
  $('k-ent').textContent = ents;
  $('k-map').textContent = `v${s.map.version}`;
  $('k-moves').textContent = s.moves + (s.pending ? ' …' : '');
  $('balance').checked = s.balance;

  // Ownership map.
  const cv = $('map');
  const { chunksX, chunksY } = s.world;
  const cell = Math.floor(Math.min(480 / chunksX, 480 / chunksY));
  cv.width = cell * chunksX;
  cv.height = cell * chunksY;
  const g = cv.getContext('2d');
  const maxE = Math.max(1, ...s.chunkEntities);
  for (let i = 0; i < s.map.owner.length; i++) {
    const cx = i % chunksX;
    const cy = (i - cx) / chunksX;
    const k = s.chunkEntities[i] / maxE;
    g.fillStyle = shardColor(s.map.owner[i], 12 + k * 50);
    g.fillRect(cx * cell, cy * cell, cell - 1, cell - 1);
  }
  const legend = $('legend');
  legend.textContent = '';
  for (let sh = 0; sh < s.shardCount; sh++) {
    const span = document.createElement('span');
    const sw = document.createElement('i');
    sw.className = 'sw';
    sw.style.background = shardColor(sh);
    span.append(sw, `分片 ${sh}`);
    legend.append(span);
  }

  const shardsEl = $('shards');
  shardsEl.textContent = '';
  for (const r of s.shards) {
    const tr = document.createElement('tr');
    const name = td('');
    const sw = document.createElement('i');
    sw.className = 'sw';
    sw.style.background = shardColor(r.shard);
    name.append(sw, String(r.shard));
    tr.append(name, td(`${r.tickMs} / ${r.raw}`, r.tickMs > 30 ? 'err' : ''), td(r.entities), td(r.chunks), td(ago(r.age)));
    shardsEl.append(tr);
  }

  const gwEl = $('gateways');
  gwEl.textContent = '';
  for (const gw of s.gateways) {
    const tr = document.createElement('tr');
    tr.append(td(gw.gateway), td(gw.online));
    gwEl.append(tr);
  }

  const chatEl = $('chat');
  chatEl.textContent = '';
  for (const m of s.chat) {
    const tr = document.createElement('tr');
    tr.append(td(fmtTime(m.t)), td(`${m.name} (${m.pid})`), td(m.text, 'wrap'), actions(m.pid, m.name));
    chatEl.append(tr);
  }

  const sanEl = $('sanctions');
  sanEl.textContent = '';
  for (const x of s.sanctions) {
    const tr = document.createElement('tr');
    const who = [x.name || '', x.pid !== undefined ? `pid ${x.pid}` : '', x.ipHash ? `IP#${x.ipHash.slice(0, 6)}` : ''].filter(Boolean).join(' · ');
    const lift = document.createElement('td');
    const b = document.createElement('button');
    b.textContent = '解除';
    b.addEventListener('click', () => act('lift', { id: x.id }, '解除这条处罚？'));
    lift.append(b);
    tr.append(td(x.id), td(x.kind === 'ban' ? '封禁' : '禁言'), td(who), td(x.until ? new Date(x.until).toLocaleString() : '永久'), td(x.reason || '', 'wrap'), lift);
    sanEl.append(tr);
  }
}

// Click a chunk: move it to another shard (manual override of the balancer).
$('map').addEventListener('click', async (e) => {
  if (!state) return;
  const r = e.target.getBoundingClientRect();
  const { chunksX, chunksY } = state.world;
  const cx = Math.floor(((e.clientX - r.left) / r.width) * chunksX);
  const cy = Math.floor(((e.clientY - r.top) / r.height) * chunksY);
  const id = cy * chunksX + cx;
  const from = state.map.owner[id];
  const to = prompt(`区块 ${id}（${cx},${cy}）现在属于分片 ${from}，${state.chunkEntities[id]} 个实体。搬到哪个分片？`);
  if (to === null || to === '') return;
  act('move', { chunk: id, to: Number(to) });
});

$('balance').addEventListener('change', (e) => act('balance', { on: e.target.checked }));

$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const list = await api('players', { q: $('q').value });
    const el = $('players');
    el.textContent = '';
    for (const p of list) {
      const tr = document.createElement('tr');
      tr.append(td(p.pid), td(p.name), td(p.gw), td(fmtTime(p.last)), actions(p.pid, p.name));
      el.append(tr);
    }
  } catch (err) {
    alert(`失败：${err.message}`);
  }
});

if (token) start();
else showApp(false);

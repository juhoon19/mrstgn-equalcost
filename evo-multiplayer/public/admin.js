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

let who = null;
let metaTick = 0;
async function refresh() {
  try {
    if (!who) {
      who = await api('whoami');
      $('whoami').textContent = `${who.name} · ${who.role === 'admin' ? '管理员' : '版主'}`;
      for (const s of document.querySelectorAll('[data-meta]')) s.hidden = !who.meta;
    }
    if (who.meta && metaTick++ % 5 === 0) refreshMeta();
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
  who = null;
  $('whoami').textContent = '';
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
$('staff-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-err').textContent = '';
  const res = await fetch('/admin/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: $('s-name').value.trim(), password: $('s-pass').value, totp: $('s-totp').value.trim() || undefined }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('login-err').textContent = data.error || '登录失败';
    return;
  }
  token = data.token;
  sessionStorage.setItem('adminToken', token);
  $('s-pass').value = '';
  start();
});

// ------------------------------------------------- accounts / reports
async function metaApi(name, { method = 'GET', body, params } = {}) {
  const qs = params ? '?' + new URLSearchParams(params) : '';
  return api(`meta/${name}${qs}`, { method, body });
}
const fmt = (t) => new Date(t).toLocaleString();

async function refreshMeta() {
  try {
    const [reports, audit, eco] = await Promise.all([metaApi('reports'), metaApi('audit'), metaApi('economy')]);
    renderReports(reports);
    renderAudit(audit);
    $('e-circ').textContent = eco.circulating;
    $('e-minted').textContent = eco.minted;
    $('e-sunk').textContent = eco.sunk;
    $('e-items').textContent = `${eco.items} / ${eco.openListings}`;
    const replicas = eco.replicas ? ` · 账号服务 ${eco.replicasUp}/${eco.replicas} 个副本在线 · ${eco.accountsOnline} 个账号在线` : '';
    $('e-check').textContent = (eco.balanceSum === 0 ? '账目守恒检查：通过（所有余额之和 = 0）' : `⚠ 账目不平：${eco.balanceSum}`) + replicas;
    $('e-check').className = eco.balanceSum === 0 && eco.replicasUp === eco.replicas ? 'muted' : 'err';
  } catch (err) {
    $('status').textContent = `账号服务错误：${err.message}`;
  }
}

function button(text, fn, cls = '') {
  const b = document.createElement('button');
  b.textContent = text;
  if (cls) b.className = cls;
  b.addEventListener('click', fn);
  return b;
}

async function metaAct(name, body, confirmText) {
  if (confirmText && !confirm(confirmText)) return false;
  try {
    await metaApi(name, { method: 'POST', body });
    refreshMeta();
    return true;
  } catch (err) {
    alert(err.message);
    return false;
  }
}

function sanctionButtons(id, name) {
  const cell = document.createElement('td');
  cell.className = 'row-actions';
  cell.append(
    button('禁言1h', () => metaAct('sanction', { id, muteMinutes: 60, reason: prompt('原因') || '' }, `禁言 ${name} 1 小时？`)),
    button('禁言1天', () => metaAct('sanction', { id, muteMinutes: 1440, reason: prompt('原因') || '' }, `禁言 ${name} 1 天？`)),
  );
  if (who.role === 'admin') {
    cell.append(button('封号7天', () => metaAct('sanction', { id, banMinutes: 7 * 1440, reason: prompt('原因') || '' }, `封禁 ${name} 7 天？`), 'bad'));
  }
  return cell;
}

function renderReports(list) {
  const body = $('reports');
  body.textContent = '';
  if (!list.length) {
    const tr = document.createElement('tr');
    tr.append(td('没有待处理的举报', 'muted'));
    body.append(tr);
  }
  for (const r of list) {
    const tr = document.createElement('tr');
    const ev = td('', 'wrap');
    const b = document.createElement('b');
    b.textContent = r.reason || '（无）';
    ev.append(b);
    for (const m of r.context.slice(-8)) {
      const line = document.createElement('div');
      line.className = 'muted';
      line.textContent = `${m.from === r.target ? r.targetName : r.reporterName}：${m.text}`;
      ev.append(line);
    }
    const acts = sanctionButtons(r.target, r.targetName);
    acts.append(button('结案', () => metaAct('closeReport', { id: r.id, note: prompt('处理说明') || '' })));
    tr.append(td(fmt(r.at)), td(r.reporterName), td(r.targetName), ev, acts);
    body.append(tr);
  }
}

function renderAudit(list) {
  const body = $('audit');
  body.textContent = '';
  for (const a of list.slice(0, 100)) {
    const tr = document.createElement('tr');
    tr.append(td(fmt(a.at)), td(a.actorName), td(a.action), td(a.target), td(String(a.detail).slice(0, 160), 'wrap'));
    body.append(tr);
  }
}

$('acct-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const box = $('acct');
  box.textContent = '';
  try {
    const r = await metaApi('account', { params: { name: $('acct-q').value.trim() } });
    const a = r.account;
    const table = document.createElement('table');
    const rows = [
      ['id / 名字', `${a.id} / ${a.name}`],
      ['角色', a.role],
      ['在线', r.online ? '是' : '否'],
      ['余额', r.wallet.balance],
      ['物品', r.wallet.items.length],
      ['登录设备', r.sessions],
      ['两步验证', a.totp ? '已开启' : '未开启'],
      ['禁言到', a.mutedUntil > Date.now() ? fmt(a.mutedUntil) : '—'],
    ];
    for (const [k, v] of rows) {
      const tr = document.createElement('tr');
      tr.append(td(k, 'muted'), td(String(v)));
      table.append(tr);
    }
    const tr = document.createElement('tr');
    const acts = sanctionButtons(a.id, a.name);
    acts.append(button('解除禁言', () => metaAct('sanction', { id: a.id, muteMinutes: 0 })));
    if (who.role === 'admin') {
      acts.append(button('解封', () => metaAct('sanction', { id: a.id, banMinutes: 0 })));
      const sel = document.createElement('select');
      for (const r of ['player', 'mod', 'admin']) {
        const o = document.createElement('option');
        o.value = o.textContent = r;
        o.selected = r === a.role;
        sel.append(o);
      }
      sel.addEventListener('change', () => metaAct('role', { id: a.id, role: sel.value }, `把 ${a.name} 设为 ${sel.value}？`));
      acts.append(sel);
    }
    tr.append(td('操作', 'muted'), acts);
    table.append(tr);
    box.append(table);
  } catch (err) {
    box.textContent = err.message;
    box.className = 'err';
  }
});

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

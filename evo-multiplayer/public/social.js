// Accounts, inventory, market, trades, friends and private messages.
// Everything goes over the game socket as {t:'rpc'} calls; live updates
// arrive as {t:'ev'} pushes. All user text is inserted with textContent.

import { hueToRgb, rgbToCss } from '/shared/color.js';
import { powSolve } from '/shared/pow.js';

export function initSocial(api) {
  // api: { send(obj), relogin(), store, notice(text), nearestOwn(x, y),
  //        setTool(name) }
  const $ = (id) => document.getElementById(id);
  const drawer = $('drawer');
  const body = $('drawer-body');
  const pending = new Map();
  let seq = 0;
  let welcome = null;
  let tab = null;
  let dmWith = null; // { id, name }
  let releaseItem = null; // item waiting for a click on the map
  const unread = new Map(); // account -> n
  const tradeDraft = new Map(); // trade id -> Set(item ids) being edited

  // -------------------------------------------------------------- helpers
  function rpc(m, a = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error('超时，请重试'), { code: 'TIMEOUT' }));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      if (!api.send({ t: 'rpc', id, m, a })) {
        clearTimeout(timer);
        pending.delete(id);
        reject(Object.assign(new Error('未连接'), { code: 'OFFLINE' }));
      }
    });
  }

  function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
      else if (k === 'class') e.className = v;
      else if (k in e) e[k] = v;
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : String(k));
    return e;
  }
  const btn = (text, fn, cls = '') => el('button', { class: cls, type: 'button', on: { click: fn } }, text);

  function toast(text, kind = '') {
    for (const old of $('toasts').children) if (old.textContent === text) old.remove();
    const t = el('div', { class: `toast ${kind}` }, text);
    $('toasts').append(t);
    setTimeout(() => t.remove(), 5000);
  }
  const fail = (err) => toast(err.message || String(err), 'bad');
  // Runs an action, toasting errors; re-renders the tab afterwards.
  const act = (fn, after = true) => async () => {
    try {
      await fn();
      if (after) render();
    } catch (err) {
      fail(err);
    }
  };

  function swatch(data) {
    const hue = data && Number.isFinite(data.hue) ? data.hue : 0;
    const size = data && data.size ? data.size : 5;
    return el('span', { class: 'swatch', style: `background:${rgbToCss(hueToRgb(hue))};width:${8 + size * 2}px;height:${8 + size * 2}px` });
  }
  function itemLabel(it) {
    const d = it.data || {};
    return d.game === 'soup' ? `#${it.id} 体型 ${d.size ?? '?'}` : `#${it.id} ${it.kind}`;
  }

  const me = () => (welcome && welcome.account ? welcome.account : null);
  const loggedIn = () => !!me();

  // ----------------------------------------------------------------- tabs
  const TABS = { account: '账号', bag: '背包', market: '市场', trade: '交易', friends: '好友' };
  for (const [k, label] of Object.entries(TABS)) {
    const b = $(`sb-${k}`);
    if (b) b.addEventListener('click', () => open(tab === k ? null : k));
    void label;
  }
  $('drawer-close').addEventListener('click', () => open(null));

  function open(k) {
    if (holdRender && k !== 'account') return; // finish saving the codes first
    tab = k;
    drawer.classList.toggle('hidden', !k);
    for (const key of Object.keys(TABS)) $(`sb-${key}`)?.classList.toggle('active', key === k);
    if (k !== 'friends') dmWith = null;
    if (k) render();
  }

  let renderSeq = 0;
  // Set while a one-time screen (recovery codes) is showing: nothing may
  // replace it until the player confirms (zone handovers re-send welcome).
  let holdRender = false;
  async function render() {
    if (!tab || holdRender) return;
    const mySeq = ++renderSeq;
    const title = $('drawer-title');
    title.textContent = dmWith ? `与 ${dmWith.name} 的私信` : TABS[tab];
    let nodes;
    try {
      if (!loggedIn() && tab !== 'account' && tab !== 'market') nodes = [el('p', { class: 'muted' }, '登录后才能使用。'), btn('去登录 / 注册', () => open('account'), 'primary')];
      else if (tab === 'account') nodes = await viewAccount();
      else if (tab === 'bag') nodes = await viewBag();
      else if (tab === 'market') nodes = await viewMarket();
      else if (tab === 'trade') nodes = await viewTrades();
      else if (tab === 'friends') nodes = dmWith ? await viewDm() : await viewFriends();
    } catch (err) {
      nodes = [el('p', { class: 'bad' }, err.message || String(err))];
    }
    if (mySeq !== renderSeq) return; // a newer render started
    body.replaceChildren(...nodes);
    if (dmWith) {
      const log = body.querySelector('.dmlog');
      if (log) log.scrollTop = log.scrollHeight;
    }
  }

  // -------------------------------------------------------------- account
  async function viewAccount() {
    if (!welcome) return [el('p', { class: 'muted' }, '连接中…')];
    if (welcome.meta === false) return [el('p', { class: 'muted' }, '这个服务器没有启用账号系统，你以游客身份游玩。')];
    if (!loggedIn()) return viewLogin();
    const a = me();
    const w = await rpc('wallet.get');
    const out = [
      el('div', { class: 'kv' }, el('span', {}, '名字'), el('b', {}, a.name)),
      el('div', { class: 'kv' }, el('span', {}, '余额'), el('b', {}, `${w.balance} 🪙`)),
      el('div', { class: 'kv' }, el('span', {}, '物品'), el('b', {}, String(w.items.length))),
    ];
    if (a.role !== 'player') out.push(el('div', { class: 'kv' }, el('span', {}, '身份'), el('b', {}, a.role === 'admin' ? '管理员' : '版主'), el('a', { href: '/admin', target: '_blank' }, '管理后台')));
    if (a.mutedUntil > Date.now()) out.push(el('p', { class: 'bad' }, `禁言至 ${new Date(a.mutedUntil).toLocaleString()}`));

    // Privacy
    const sel = el('select', {}, ...[['everyone', '所有人'], ['friends', '仅好友'], ['nobody', '不接收']].map(([v, t]) => el('option', { value: v, selected: a.privacyDm === v }, t)));
    sel.addEventListener('change', act(async () => {
      await rpc('auth.privacy', { dm: sel.value });
      a.privacyDm = sel.value;
      toast('已保存');
    }));
    out.push(el('h4', {}, '隐私'), el('label', { class: 'line' }, '谁可以私信我 ', sel));

    // 2FA
    out.push(el('h4', {}, '两步验证'));
    if (a.totp) {
      const code = el('input', { placeholder: '6 位验证码', inputMode: 'numeric', maxLength: 6 });
      out.push(el('p', { class: 'ok' }, '已开启'), el('div', { class: 'line' }, code, btn('关闭', act(async () => {
        await rpc('auth.totpDisable', { code: code.value.trim() });
        a.totp = false;
        toast('两步验证已关闭');
      }))));
    } else {
      const box = el('div');
      out.push(box, btn('开启两步验证', act(async () => {
        const s = await rpc('auth.totpSetup');
        const code = el('input', { placeholder: '验证器上的 6 位数', inputMode: 'numeric', maxLength: 6 });
        box.replaceChildren(
          el('p', { class: 'muted' }, '在 Google Authenticator / 微软验证器等 App 中添加以下密钥，然后输入显示的验证码：'),
          el('code', { class: 'secret' }, s.secret),
          el('div', { class: 'line' }, code, btn('确认开启', act(async () => {
            await rpc('auth.totpEnable', { code: code.value.trim() });
            a.totp = true;
            toast('两步验证已开启');
          }), 'primary')),
        );
      }, false)));
    }

    // Password
    const oldPw = el('input', { type: 'password', placeholder: '原密码', autocomplete: 'current-password' });
    const newPw = el('input', { type: 'password', placeholder: '新密码（至少 8 位）', autocomplete: 'new-password' });
    out.push(el('h4', {}, '修改密码'), oldPw, newPw, btn('修改（其他设备会被登出）', act(async () => {
      await rpc('auth.password', { old: oldPw.value, new: newPw.value });
      toast('密码已修改，请重新登录');
      logoutLocal();
    }, false)));

    // Sessions
    const sessions = await rpc('auth.sessions');
    out.push(el('h4', {}, `登录设备（${sessions.length}）`), el('ul', { class: 'list small' }, ...sessions.slice(0, 8).map((s) => el('li', {}, `${s.ua || '未知设备'} · ${new Date(s.lastSeen).toLocaleString()}`))));
    out.push(
      el('div', { class: 'line' },
        btn('退出登录', act(async () => {
          await rpc('auth.logout').catch(() => {});
          logoutLocal();
        }, false)),
        btn('退出所有设备', act(async () => {
          await rpc('auth.logoutAll');
          logoutLocal();
        }, false)),
      ),
    );
    return out;
  }

  function viewLogin() {
    const name = el('input', { placeholder: '用户名（2–20 个字）', autocomplete: 'username', maxLength: 20, value: api.store.get('name', '') });
    const pw = el('input', { type: 'password', placeholder: '密码（至少 8 位）', autocomplete: 'current-password' });
    const totp = el('input', { placeholder: '两步验证码（如已开启）', inputMode: 'numeric', maxLength: 6, class: 'hidden' });
    const msg = el('p', { class: 'muted' }, '登录后可以收集生物、交易、加好友和私信。你作为游客培育的后代会自动并入账号。');
    const login = act(async () => {
      try {
        const r = await rpc('auth.login', { name: name.value.trim(), password: pw.value, totp: totp.value.trim() || undefined });
        loggedInWith(r.token);
      } catch (err) {
        if (err.code === 'TOTP_REQUIRED' || err.code === 'BAD_TOTP') totp.classList.remove('hidden');
        throw err;
      }
    }, false);
    const register = act(async () => {
      // Anti-bulk-registration check: a second or two of hashing.
      let pow;
      const ch = await rpc('auth.challenge');
      if (ch.bits > 0) {
        msg.textContent = '正在进行注册校验（防止批量注册小号），请稍候…';
        const t0 = performance.now();
        pow = { challenge: ch.challenge, nonce: await powSolve(ch.challenge, ch.bits) };
        msg.textContent = `校验完成（${((performance.now() - t0) / 1000).toFixed(1)} 秒）`;
      }
      const r = await rpc('auth.register', { name: name.value.trim(), password: pw.value, hue: Number(api.store.get('hue', 0)) / 360, pow });
      holdRender = true;
      body.replaceChildren(
        el('h4', {}, '注册成功！请保存恢复码'),
        el('p', { class: 'muted' }, '忘记密码时，每个恢复码可以用一次来重置密码。它们只显示这一次：'),
        el('pre', { class: 'secret' }, r.recoveryCodes.join('\n')),
        btn('我已保存，进入游戏', () => {
          holdRender = false;
          loggedInWith(r.token);
        }, 'primary'),
      );
    }, false);
    pw.addEventListener('keydown', (e) => e.key === 'Enter' && login());
    // Recovery
    const rName = el('input', { placeholder: '用户名' });
    const rCode = el('input', { placeholder: '恢复码' });
    const rPw = el('input', { type: 'password', placeholder: '新密码' });
    const rec = el('details', {}, el('summary', {}, '忘记密码？用恢复码重置'), rName, rCode, rPw, btn('重置并登录', act(async () => {
      const r = await rpc('auth.recover', { name: rName.value.trim(), code: rCode.value.trim(), newPassword: rPw.value });
      toast(`已重置，还剩 ${r.codesLeft} 个恢复码`);
      loggedInWith(r.token);
    }, false)));
    return [msg, name, pw, totp, el('div', { class: 'line' }, btn('登录', login, 'primary'), btn('注册新账号', register)), rec];
  }

  function loggedInWith(token) {
    api.store.set('session', token);
    if (!loggedIn()) toast('已登录：你作为游客时培育的后代已归入这个账号', 'ok');
    api.relogin();
  }
  function logoutLocal() {
    api.store.set('session', '');
    api.relogin();
  }

  // ------------------------------------------------------------------ bag
  async function viewBag() {
    const w = await rpc('wallet.get');
    const out = [
      el('div', { class: 'kv' }, el('span', {}, '余额'), el('b', {}, `${w.balance} 🪙`)),
      el('p', { class: 'muted small' }, '用「🫙 收集」工具点击你自己谱系的生物把它收进背包；放生会消耗 5 🪙。你的后代活着就会慢慢赚钱。'),
    ];
    if (!w.items.length) out.push(el('p', { class: 'muted' }, '背包是空的。'));
    for (const it of w.items) {
      const price = el('input', { type: 'number', min: 1, placeholder: '价格', class: 'num' });
      const locked = !!it.lock;
      out.push(
        el('div', { class: 'item' },
          swatch(it.data),
          el('span', { class: 'grow' }, itemLabel(it), locked ? el('em', { class: 'muted' }, ' · 挂单中') : null),
          locked ? null : btn('放生', () => {
            releaseItem = it.id;
            api.setTool('release');
            toast('点击地图上的位置放生（Esc 取消）');
          }),
          locked ? null : el('span', { class: 'line tight' }, price, btn('挂单', act(async () => {
            await rpc('market.list', { item: it.id, price: Number(price.value) });
            toast('已挂到市场');
          }))),
        ),
      );
    }
    return out;
  }

  // Called by the client for clicks on the map while the capture/release
  // tool is active. Returns true if handled.
  function onMapClick(tool, x, y) {
    if (tool === 'release') {
      if (!releaseItem) return false;
      const item = releaseItem;
      releaseItem = null;
      api.setTool('pan');
      rpc('item.release', { item, x, y })
        .then((r) => {
          toast(r && r.uncertain ? '已放生（世界服务器响应较慢，生物可能稍后才出现）' : '已放生');
          if (tab === 'bag') render();
        })
        .catch(fail);
      return true;
    }
    if (tool === 'capture') {
      if (!loggedIn()) {
        toast('登录后才能收集生物', 'bad');
        open('account');
        return true;
      }
      const e = api.nearestOwn(x, y);
      if (!e) {
        toast('附近没有你谱系的生物', 'bad');
        return true;
      }
      rpc('item.capture', { entityId: e.id, x: e.x, y: e.y })
        .then(() => {
          toast('已收进背包');
          if (tab === 'bag') render();
        })
        .catch(fail);
      return true;
    }
    return false;
  }
  function cancelRelease() {
    releaseItem = null;
  }

  // --------------------------------------------------------------- market
  async function viewMarket() {
    const list = await rpc('market.browse', {});
    const out = [el('p', { class: 'muted small' }, '成交收 5% 手续费（销毁，用于抑制通胀）。')];
    if (loggedIn()) {
      const mine = await rpc('market.mine');
      if (mine.length) {
        out.push(el('h4', {}, '我的挂单'));
        for (const l of mine) out.push(el('div', { class: 'item' }, el('span', { class: 'grow' }, `物品 #${l.item} · ${l.price} 🪙`), btn('撤下', act(() => rpc('market.cancel', { listing: l.id })))));
      }
    }
    out.push(el('h4', {}, `在售（${list.length}）`));
    if (!list.length) out.push(el('p', { class: 'muted' }, '还没有人挂单。'));
    const myId = me()?.id;
    for (const l of list) {
      out.push(
        el('div', { class: 'item' },
          swatch(l.data),
          el('span', { class: 'grow' }, itemLabel({ id: l.item, data: l.data, kind: 'specimen' }), el('br'), el('span', { class: 'muted small' }, `卖家 ${l.sellerName}`)),
          el('b', {}, `${l.price} 🪙`),
          l.seller === myId || !loggedIn() ? null : btn('购买', act(async () => {
            await rpc('market.buy', { listing: l.id });
            toast('购买成功，已放进背包', 'ok');
          })),
        ),
      );
    }
    return out;
  }

  // --------------------------------------------------------------- trades
  async function viewTrades() {
    const trades = await rpc('trade.mine');
    const who = el('input', { placeholder: '对方用户名' });
    const out = [el('div', { class: 'line' }, who, btn('发起交易', act(() => rpc('trade.open', { name: who.value.trim() }))))];
    out.push(el('p', { class: 'muted small' }, '双方摆好物品和金额后各自确认；任何一方改动都会让确认失效，成交的就是你确认时看到的内容。'));
    if (!trades.length) out.push(el('p', { class: 'muted' }, '没有进行中的交易。'));
    const w = trades.length ? await rpc('wallet.get') : null;
    for (const t of trades) out.push(tradeCard(t, w));
    return out;
  }

  function tradeCard(t, w) {
    const myId = me().id;
    const mine = t.a === myId ? 'a' : 'b';
    const theirs = mine === 'a' ? 'b' : 'a';
    const side = (s) => {
      const items = t[`${s}Items`].map((id) => t.items?.[id] || { id, data: null, kind: '?' });
      return el('div', { class: 'side' },
        el('b', {}, s === mine ? '我出' : `${t[`${s}Name`] || '对方'} 出`, t[`${s}Ok`] ? ' ✅' : ''),
        ...items.map((it) => el('div', { class: 'small' }, swatch(it.data), ' ', itemLabel(it))),
        el('div', { class: 'small' }, `${t[`${s}Coins`]} 🪙`),
      );
    };
    // Offer editor: my free items as checkboxes + coins.
    let draft = tradeDraft.get(t.id);
    if (!draft) tradeDraft.set(t.id, (draft = new Set(t[`${mine}Items`])));
    const coins = el('input', { type: 'number', min: 0, value: t[`${mine}Coins`], class: 'num' });
    const picks = (w?.items || []).filter((it) => !it.lock).map((it) => {
      const cb = el('input', { type: 'checkbox', checked: draft.has(it.id) });
      cb.addEventListener('change', () => (cb.checked ? draft.add(it.id) : draft.delete(it.id)));
      return el('label', { class: 'small pick' }, cb, swatch(it.data), itemLabel(it));
    });
    return el('div', { class: 'trade' },
      el('div', { class: 'muted small' }, `交易 #${t.id} · 版本 ${t.version}`),
      el('div', { class: 'sides' }, side(mine), side(theirs)),
      el('details', {}, el('summary', {}, '修改我的出价'), ...picks, el('div', { class: 'line' }, '金额 ', coins, btn('更新出价', act(() => rpc('trade.offer', { id: t.id, items: [...draft], coins: Number(coins.value) || 0 }))))),
      el('div', { class: 'line' },
        t[`${mine}Ok`] ? el('span', { class: 'muted' }, '已确认，等对方…') : btn('确认这个版本', act(async () => {
          const r = await rpc('trade.confirm', { id: t.id, version: t.version });
          if (r.status === 'done') toast('交易完成', 'ok');
        }), 'primary'),
        btn('取消交易', act(() => rpc('trade.cancel', { id: t.id }))),
      ),
    );
  }

  // -------------------------------------------------------------- friends
  async function viewFriends() {
    const [list, blocks] = await Promise.all([rpc('friends.list'), rpc('block.list')]);
    const name = el('input', { placeholder: '用户名' });
    const out = [el('div', { class: 'line' }, name, btn('加好友', act(async () => {
      const r = await rpc('friends.request', { name: name.value.trim() });
      toast(r.status === 'accepted' ? '你们已经是好友了' : '已发送好友申请');
    })), btn('私信', act(async () => {
      const p = await rpc('player.find', { name: name.value.trim() });
      if (!p) throw new Error('没有这个玩家');
      dmWith = { id: p.id, name: p.name };
    })))];
    const incoming = list.filter((f) => f.status === 'incoming');
    if (incoming.length) {
      out.push(el('h4', {}, '好友申请'));
      for (const f of incoming) {
        out.push(el('div', { class: 'item' }, el('span', { class: 'grow' }, f.name),
          btn('接受', act(() => rpc('friends.respond', { from: f.id, accept: true })), 'primary'),
          btn('拒绝', act(() => rpc('friends.respond', { from: f.id, accept: false }))),
        ));
      }
    }
    const friends = list.filter((f) => f.status === 'accepted').sort((a, b) => b.online - a.online);
    out.push(el('h4', {}, `好友（${friends.length}）`));
    // Unread from people who are not friends.
    for (const [id, n] of unread) if (!friends.some((f) => f.id === id)) out.push(el('div', { class: 'item' }, el('span', { class: 'grow' }, `陌生人消息 (${n})`), btn('查看', () => openDm(id, unreadNames.get(id) || `#${id}`))));
    for (const f of friends) {
      const n = unread.get(f.id) || 0;
      out.push(
        el('div', { class: 'item' },
          el('span', { class: `dot ${f.online ? 'on' : ''}` }),
          el('span', { class: 'grow' }, f.name, n ? el('span', { class: 'badge' }, String(n)) : null),
          btn('私信', () => openDm(f.id, f.name)),
          btn('交易', act(async () => {
            await rpc('trade.open', { with: f.id });
            open('trade');
          }, false)),
          el('details', { class: 'more' }, el('summary', {}, '…'),
            btn('删除好友', act(() => rpc('friends.remove', { id: f.id }))),
            btn('屏蔽', act(() => rpc('block.add', { id: f.id }))),
            btn('举报', () => report(f.id, f.name)),
          ),
        ),
      );
    }
    const outgoing = list.filter((f) => f.status === 'outgoing');
    if (outgoing.length) out.push(el('p', { class: 'muted small' }, `等待对方通过：${outgoing.map((f) => f.name).join('、')}`));
    if (blocks.length) {
      out.push(el('h4', {}, '已屏蔽'));
      for (const b of blocks) out.push(el('div', { class: 'item' }, el('span', { class: 'grow' }, b.name), btn('解除', act(() => rpc('block.remove', { id: b.id })))));
    }
    return out;
  }
  const unreadNames = new Map();

  function openDm(id, name) {
    dmWith = { id, name };
    open('friends');
  }

  async function report(id, name) {
    const reason = prompt(`举报 ${name} 的原因（最近的私信会作为证据自动附上）：`);
    if (!reason) return;
    try {
      await rpc('report.create', { target: id, reason });
      toast('已提交举报，管理员会处理', 'ok');
    } catch (err) {
      fail(err);
    }
  }

  async function viewDm() {
    const who = dmWith;
    const hist = await rpc('dm.history', { with: who.id });
    if (unread.has(who.id)) {
      unread.delete(who.id);
      rpc('dm.read', { with: who.id }).catch(() => {});
      updateBadge();
    }
    const log = el('div', { class: 'dmlog' }, ...hist.map(dmLine));
    const input = el('input', { maxLength: 500, placeholder: '输入消息，回车发送' });
    const sendIt = async () => {
      const text = input.value.trim();
      if (!text) return;
      try {
        await rpc('dm.send', { to: who.id, text });
        input.value = '';
      } catch (err) {
        fail(err);
      }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // don't trigger game shortcuts
      if (e.key === 'Enter') sendIt();
    });
    setTimeout(() => input.focus(), 0);
    return [
      el('div', { class: 'line' }, btn('← 返回', () => {
        dmWith = null;
        render();
      }), btn('举报', () => report(who.id, who.name)), btn('屏蔽', act(async () => {
        await rpc('block.add', { id: who.id });
        dmWith = null;
      }))),
      log,
      el('div', { class: 'line' }, input, btn('发送', sendIt, 'primary')),
      el('p', { class: 'muted small' }, '不要相信要你去其他网站或 App 交易的人；平台内的交易有托管保护。'),
    ];
  }

  function dmLine(m) {
    const mine = m.from === me()?.id;
    return el('div', { class: `dm ${mine ? 'mine' : ''}` }, el('span', {}, m.text), el('time', {}, new Date(m.at).toLocaleTimeString()));
  }

  function updateBadge() {
    let n = 0;
    for (const v of unread.values()) n += v;
    const b = $('sb-friends-badge');
    if (b) {
      b.textContent = n > 99 ? '99+' : String(n);
      b.classList.toggle('hidden', n === 0);
    }
  }

  // --------------------------------------------------------------- events
  // Pushes can arrive in bursts (many friends logging in): coalesce the
  // re-renders they cause so the panel doesn't exceed the call rate limit.
  let renderTimer = null;
  function renderSoon() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 300);
  }

  // During a zone handover both connections are registered for a moment and
  // the same push can arrive twice: drop exact repeats within a few seconds.
  const recentEvents = new Map(); // json -> t
  function onEvent(ev) {
    const key = JSON.stringify(ev);
    const now = Date.now();
    if (now - (recentEvents.get(key) || 0) < 5000) return;
    recentEvents.set(key, now);
    if (recentEvents.size > 200) for (const [k, t] of recentEvents) if (now - t > 5000) recentEvents.delete(k);
    switch (ev.type) {
      case 'dm': {
        const m = ev.msg;
        const other = m.from === me()?.id ? m.to : m.from;
        if (dmWith && dmWith.id === other && tab === 'friends') {
          const log = body.querySelector('.dmlog');
          if (log) {
            log.append(dmLine(m));
            log.scrollTop = log.scrollHeight;
          }
          if (m.from !== me()?.id) rpc('dm.read', { with: other }).catch(() => {});
        } else if (m.from !== me()?.id) {
          unread.set(other, (unread.get(other) || 0) + 1);
          unreadNames.set(other, ev.fromName);
          updateBadge();
          toast(`💬 ${ev.fromName}：${m.text.slice(0, 40)}`);
        }
        break;
      }
      case 'friend':
        if (ev.status === 'incoming') toast(`👥 ${ev.name} 想加你为好友`);
        else if (ev.status === 'accepted') toast(`👥 你和 ${ev.name} 成为了好友`, 'ok');
        if (tab === 'friends' && !dmWith) renderSoon();
        break;
      case 'presence':
        if (tab === 'friends' && !dmWith) renderSoon();
        break;
      case 'trade': {
        const t = ev.trade;
        const other = t.a === me()?.id ? t.bName : t.aName;
        if (t.status === 'done') toast(`🤝 与 ${other} 的交易完成`, 'ok');
        else if (t.status === 'cancelled') toast(`与 ${other} 的交易已取消`);
        else if (tab !== 'trade') toast(`🤝 ${other} 的交易有更新`);
        if (t.status !== 'open') tradeDraft.delete(t.id);
        if (tab === 'trade' || tab === 'bag') renderSoon();
        break;
      }
      case 'sold':
        toast(`🪙 你的挂单以 ${ev.price} 售出（手续费 ${ev.fee}）`, 'ok');
        if (tab === 'bag' || tab === 'market') renderSoon();
        break;
      case 'muted':
        if (me()) me().mutedUntil = ev.until;
        toast(`你被禁言至 ${new Date(ev.until).toLocaleString()}${ev.reason ? '：' + ev.reason : ''}`, 'bad');
        break;
      case 'banned':
        toast('账号已被封禁', 'bad');
        break;
      case 'session-expired':
        api.store.set('session', '');
        toast('登录已过期，请重新登录');
        break;
    }
  }

  async function onWelcome(msg) {
    const sameAccount = welcome && (welcome.account?.id ?? 0) === (msg.account?.id ?? 0);
    welcome = msg;
    // Server without the account system: hide everything that needs it.
    $('social').classList.toggle('hidden', msg.meta === false);
    document.querySelector('#tools [data-tool="capture"]')?.classList.toggle('hidden', msg.meta === false);
    $('sb-account').querySelector('span').textContent = msg.account ? msg.account.name : '登录';
    for (const k of ['bag', 'trade', 'friends']) $(`sb-${k}`)?.classList.toggle('dim', !msg.account);
    if (sameAccount) return; // zone handover: same person, nothing to reload
    if (tab) render();
    if (msg.account) {
      try {
        const list = await rpc('dm.unread');
        unread.clear();
        for (const u of list) {
          unread.set(u.id, u.n);
          unreadNames.set(u.id, u.name);
        }
        updateBadge();
      } catch {
        /* ignore */
      }
    }
  }

  function onRpcReply(msg) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.r);
    else p.reject(Object.assign(new Error(msg.msg || msg.code), { code: msg.code }));
  }

  return { onEvent, onWelcome, onRpcReply, onMapClick, cancelRelease, open, toast, busy: () => pending.size > 0 };
}

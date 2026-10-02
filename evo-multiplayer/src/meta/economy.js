// Economy on top of the ledger primitives: marketplace, player-to-player
// trades, the world <-> item bridge (capture / release) and world rewards.
//
// Design rule: world entities have NO value; only items in the ledger do.
// The simulation may roll back a few seconds after a crash, so an organism
// can reappear - but it can only be turned into an item once (the item's
// source key is the organism's world-unique id), so a rollback can never
// duplicate value. Releasing an item consumes it first and spawns second:
// if the spawn is lost, the player loses a specimen (logged, restorable by
// an admin) rather than the economy gaining a copy ("fail closed").

import { AppError, move, mint, burn, createItem, lockItem, unlockItem, transferItem, consumeItem, itemsOf, balanceOf } from './ledger.js';
import { SINK } from './store.js';

export const MARKET_FEE = 0.05; // 5% of every sale leaves the economy
export const RELEASE_FEE = 5;
export const MAX_PRICE = 1e9;
export const MAX_OPEN_LISTINGS = 50;
export const MAX_OPEN_TRADES = 5;
export const MAX_TRADE_ITEMS = 12;
export const CAPTURES_PER_DAY = 50;

const int = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new AppError('BAD_ARG', `${name} must be an integer`);
  return n;
};

export class Economy {
  constructor(store, { notify = () => {} } = {}) {
    this.store = store;
    this.notify = notify; // (accountId, event) -> void, for live updates
  }

  balance(acct) {
    return balanceOf(this.store, acct);
  }

  items(acct) {
    return itemsOf(this.store, acct);
  }

  async wallet(acct) {
    return { balance: await this.balance(acct), items: await this.items(acct) };
  }

  // ---------------------------------------------------------------- market

  async list(seller, itemId, price) {
    itemId = int(itemId, 'item');
    price = int(price, 'price');
    if (price < 1 || price > MAX_PRICE) throw new AppError('BAD_PRICE', `价格需在 1 到 ${MAX_PRICE} 之间`);
    return this.store.tx(async (t) => {
      const open = await t.query("SELECT count(*) AS n FROM listings WHERE seller = $1 AND status = 'open'", [seller]);
      if (Number(open.rows[0].n) >= MAX_OPEN_LISTINGS) throw new AppError('TOO_MANY', `最多同时挂 ${MAX_OPEN_LISTINGS} 件`);
      const r = await t.query('INSERT INTO listings(seller, item, price, created) VALUES ($1, $2, $3, $4) RETURNING id', [seller, itemId, price, Date.now()]);
      const id = Number(r.rows[0].id);
      await lockItem(t, itemId, seller, `L:${id}`);
      return { listing: id };
    });
  }

  async cancelListing(seller, listingId) {
    listingId = int(listingId, 'listing');
    return this.store.tx(async (t) => {
      const r = await t.query("UPDATE listings SET status = 'cancelled', closed = $1 WHERE id = $2 AND seller = $3 AND status = 'open' RETURNING item", [
        Date.now(),
        listingId,
        seller,
      ]);
      if (r.rows.length === 0) throw new AppError('NOT_FOUND', '挂单不存在或已结束');
      await unlockItem(t, Number(r.rows[0].item), `L:${listingId}`);
      return { cancelled: listingId };
    });
  }

  async buy(buyer, listingId) {
    listingId = int(listingId, 'listing');
    const out = await this.store.tx(async (t) => {
      // The conditional status flip is the "only one buyer" gate.
      const r = await t.query(
        "UPDATE listings SET status = 'sold', buyer = $1, closed = $2 WHERE id = $3 AND status = 'open' AND seller <> $1 RETURNING seller, item, price",
        [buyer, Date.now(), listingId],
      );
      if (r.rows.length === 0) throw new AppError('UNAVAILABLE', '已售出、已撤下或是你自己的挂单');
      const { seller, item, price } = r.rows[0];
      const fee = Math.max(1, Math.ceil(Number(price) * MARKET_FEE));
      const pay = Number(price) - fee;
      if (pay > 0) await move(t, { key: `buy:${listingId}:pay`, kind: 'market', from: buyer, to: Number(seller), amount: pay, ref: `listing:${listingId}` });
      await move(t, { key: `buy:${listingId}:fee`, kind: 'fee', from: buyer, to: SINK, amount: fee, ref: `listing:${listingId}` });
      await transferItem(t, Number(item), Number(seller), buyer, `L:${listingId}`, `listing:${listingId}`);
      return { seller: Number(seller), item: Number(item), price: Number(price), fee };
    });
    this.notify(out.seller, { type: 'sold', listing: listingId, price: out.price, fee: out.fee });
    return out;
  }

  async browse({ kind = 'specimen', maxPrice, page = 0 } = {}) {
    const params = [kind];
    let where = "l.status = 'open' AND i.kind = $1";
    if (maxPrice) {
      params.push(int(maxPrice, 'maxPrice'));
      where += ` AND l.price <= $${params.length}`;
    }
    params.push(Math.max(0, int(page, 'page')) * 50);
    const r = await this.store.query(
      `SELECT l.id, l.price, l.created, l.seller, a.display AS seller_name, i.id AS item, i.data
         FROM listings l JOIN items i ON i.id = l.item JOIN accounts a ON a.id = l.seller
        WHERE ${where} ORDER BY l.id DESC LIMIT 50 OFFSET $${params.length}`,
      params,
    );
    return r.rows.map((x) => ({
      id: Number(x.id),
      price: Number(x.price),
      created: Number(x.created),
      seller: Number(x.seller),
      sellerName: x.seller_name,
      item: Number(x.item),
      data: JSON.parse(x.data),
    }));
  }

  async myListings(seller) {
    const r = await this.store.query("SELECT id, item, price, created FROM listings WHERE seller = $1 AND status = 'open' ORDER BY id DESC", [seller]);
    return r.rows.map((x) => ({ id: Number(x.id), item: Number(x.item), price: Number(x.price), created: Number(x.created) }));
  }

  // ---------------------------------------------------------------- trades
  // Two-step, version-checked: any change bumps `version` and clears both
  // confirmations; you confirm a specific version, so what executes is
  // exactly what you saw (no last-second swaps). Items are not escrowed while
  // negotiating; ownership and balances are re-checked atomically at the end.

  tradeView(row) {
    return {
      id: Number(row.id),
      a: Number(row.a),
      b: Number(row.b),
      status: row.status,
      version: Number(row.version),
      aItems: JSON.parse(row.a_items),
      bItems: JSON.parse(row.b_items),
      aCoins: Number(row.a_coins),
      bCoins: Number(row.b_coins),
      aOk: !!Number(row.a_ok),
      bOk: !!Number(row.b_ok),
    };
  }

  async openTrade(a, b, blocked) {
    b = int(b, 'with');
    if (a === b) throw new AppError('BAD_ARG', '不能和自己交易');
    if (await blocked(a, b)) throw new AppError('BLOCKED', '对方不接受你的交易');
    const exists = await this.store.query('SELECT id FROM accounts WHERE id = $1', [b]);
    if (!exists.rows.length) throw new AppError('NOT_FOUND', '没有这个玩家');
    const view = await this.store.tx(async (t) => {
      const open = await t.query("SELECT count(*) AS n FROM trades WHERE (a = $1 OR b = $1) AND status = 'open'", [a]);
      if (Number(open.rows[0].n) >= MAX_OPEN_TRADES) throw new AppError('TOO_MANY', '进行中的交易太多');
      const now = Date.now();
      const r = await t.query('INSERT INTO trades(a, b, created, updated) VALUES ($1, $2, $3, $3) RETURNING *', [a, b, now]);
      return this.tradeView(r.rows[0]);
    });
    this.notifyTrade(view);
    return view;
  }

  async getTrade(acct, id) {
    const r = await this.store.query('SELECT * FROM trades WHERE id = $1 AND (a = $2 OR b = $2)', [int(id, 'trade'), acct]);
    if (!r.rows.length) throw new AppError('NOT_FOUND', '交易不存在');
    return this.tradeView(r.rows[0]);
  }

  async myTrades(acct) {
    const r = await this.store.query("SELECT * FROM trades WHERE (a = $1 OR b = $1) AND status = 'open' ORDER BY id DESC", [acct]);
    return r.rows.map((x) => this.tradeView(x));
  }

  async setOffer(acct, id, { items = [], coins = 0 }) {
    id = int(id, 'trade');
    coins = int(coins, 'coins');
    if (coins < 0 || coins > MAX_PRICE) throw new AppError('BAD_AMOUNT', '金额无效');
    if (!Array.isArray(items) || items.length > MAX_TRADE_ITEMS) throw new AppError('BAD_ARG', `最多放 ${MAX_TRADE_ITEMS} 件物品`);
    const ids = [...new Set(items.map((x) => int(x, 'item')))];
    const view = await this.store.tx(async (t) => {
      const r = await t.query(`SELECT * FROM trades WHERE id = $1${this.store.forUpdate}`, [id]);
      const tr = r.rows[0];
      if (!tr || tr.status !== 'open' || (Number(tr.a) !== acct && Number(tr.b) !== acct)) throw new AppError('NOT_FOUND', '交易不存在或已结束');
      for (const it of ids) {
        const o = await t.query("SELECT id FROM items WHERE id = $1 AND owner = $2 AND state = 'held' AND lock IS NULL", [it, acct]);
        if (!o.rows.length) throw new AppError('ITEM_UNAVAILABLE', `物品 ${it} 不在你手上或已被占用`);
      }
      if (coins > (await balanceOf(t, acct))) throw new AppError('INSUFFICIENT_FUNDS', '余额不足');
      const side = Number(tr.a) === acct ? 'a' : 'b';
      const u = await t.query(
        `UPDATE trades SET ${side}_items = $1, ${side}_coins = $2, a_ok = 0, b_ok = 0, version = version + 1, updated = $3 WHERE id = $4 RETURNING *`,
        [JSON.stringify(ids), coins, Date.now(), id],
      );
      return this.tradeView(u.rows[0]);
    });
    this.notifyTrade(view);
    return view;
  }

  async confirm(acct, id, version) {
    id = int(id, 'trade');
    version = int(version, 'version');
    let view;
    try {
      view = await this.store.tx(async (t) => {
        const r = await t.query(`SELECT * FROM trades WHERE id = $1${this.store.forUpdate}`, [id]);
        const tr = r.rows[0];
        if (!tr || tr.status !== 'open' || (Number(tr.a) !== acct && Number(tr.b) !== acct)) throw new AppError('NOT_FOUND', '交易不存在或已结束');
        if (Number(tr.version) !== version) throw new AppError('CHANGED', '交易内容已变化，请重新确认');
        const side = Number(tr.a) === acct ? 'a' : 'b';
        const other = side === 'a' ? 'b' : 'a';
        if (!Number(tr[`${other}_ok`])) {
          const u = await t.query(`UPDATE trades SET ${side}_ok = 1, updated = $1 WHERE id = $2 AND version = $3 RETURNING *`, [Date.now(), id, version]);
          return this.tradeView(u.rows[0]);
        }
        // Both sides agreed on this exact version: execute atomically.
        const A = Number(tr.a);
        const B = Number(tr.b);
        for (const it of JSON.parse(tr.a_items)) await transferItem(t, it, A, B, null, `trade:${id}`);
        for (const it of JSON.parse(tr.b_items)) await transferItem(t, it, B, A, null, `trade:${id}`);
        if (Number(tr.a_coins) > 0) await move(t, { key: `trade:${id}:a`, kind: 'trade', from: A, to: B, amount: Number(tr.a_coins), ref: `trade:${id}` });
        if (Number(tr.b_coins) > 0) await move(t, { key: `trade:${id}:b`, kind: 'trade', from: B, to: A, amount: Number(tr.b_coins), ref: `trade:${id}` });
        const u = await t.query("UPDATE trades SET status = 'done', a_ok = 1, b_ok = 1, updated = $1 WHERE id = $2 RETURNING *", [Date.now(), id]);
        return this.tradeView(u.rows[0]);
      });
    } catch (err) {
      if (err.code === 'ITEM_UNAVAILABLE' || err.code === 'INSUFFICIENT_FUNDS') {
        // Something changed since the offer (item sold elsewhere, money spent):
        // reset confirmations so both sides look again.
        const u = await this.store.query("UPDATE trades SET a_ok = 0, b_ok = 0, version = version + 1, updated = $1 WHERE id = $2 AND status = 'open' RETURNING *", [
          Date.now(),
          id,
        ]);
        if (u.rows[0]) this.notifyTrade(this.tradeView(u.rows[0]));
      }
      throw err;
    }
    this.notifyTrade(view);
    return view;
  }

  async cancelTrade(acct, id) {
    const r = await this.store.query(
      "UPDATE trades SET status = 'cancelled', updated = $1 WHERE id = $2 AND (a = $3 OR b = $3) AND status = 'open' RETURNING *",
      [Date.now(), int(id, 'trade'), acct],
    );
    if (!r.rows.length) throw new AppError('NOT_FOUND', '交易不存在或已结束');
    const view = this.tradeView(r.rows[0]);
    this.notifyTrade(view);
    return view;
  }

  notifyTrade(view) {
    this.notify(view.a, { type: 'trade', trade: view });
    this.notify(view.b, { type: 'trade', trade: view });
  }

  // ------------------------------------------------------ world <-> items

  async captureAllowed(acct) {
    const since = Date.now() - 24 * 3600 * 1000;
    const r = await this.store.query("SELECT count(*) AS n FROM item_log WHERE to_acct = $1 AND action = 'create' AND at > $2", [acct, since]);
    return Number(r.rows[0].n) < CAPTURES_PER_DAY;
  }

  // A shard removed an organism; turn it into an item exactly once.
  async captured(acct, sourceKey, data) {
    if (typeof sourceKey !== 'string' || !sourceKey.startsWith('cap:')) throw new AppError('BAD_ARG', 'bad source key');
    return this.store.tx(async (t) => {
      const r = await createItem(t, { owner: acct, kind: 'specimen', data, sourceKey });
      if (!r.created) {
        // Same organism again (a retried request, or a shard that crashed
        // before its snapshot resurrected it): never a second item, and
        // never someone else's existing one.
        const ex = await t.query('SELECT 1 FROM item_log WHERE item = $1 AND action = $2 AND to_acct = $3', [r.id, 'create', acct]);
        if (!ex.rows.length) throw new AppError('ALREADY_CAPTURED', '这个生物已经被收集过了');
      }
      return { item: r.id, created: r.created };
    });
  }

  // Consume an item (and the release fee) and hand back what to spawn.
  async release(acct, itemId) {
    itemId = int(itemId, 'item');
    return this.store.tx(async (t) => {
      const r = await t.query("SELECT data FROM items WHERE id = $1 AND owner = $2 AND state = 'held' AND lock IS NULL", [itemId, acct]);
      if (!r.rows.length) throw new AppError('ITEM_UNAVAILABLE', '物品不在你手上或已被占用');
      await burn(t, acct, RELEASE_FEE, `release:${itemId}`, 'release_fee', `item:${itemId}`);
      await consumeItem(t, itemId, acct, 'release');
      return { item: itemId, data: JSON.parse(r.rows[0].data), spawnKey: `rel:${itemId}` };
    });
  }

  // World rewards: entries [[account, amount]] minted once per key.
  // `period` names the reward period (all shards report the same one) and
  // `cap` is the most one account may earn in it IN TOTAL: a lineage spread
  // over 64 shards must not earn 64 times as much. The account's balance row
  // is locked first so concurrent reports from different shards serialise.
  async reward(entries, keyPrefix, { period = keyPrefix, cap = Infinity } = {}) {
    let paid = 0;
    for (const [acct, amount] of entries) {
      if (!(acct > 0) || !(amount > 0)) continue;
      const r = await this.store.tx(async (t) => {
        await t.query(`SELECT amount FROM balances WHERE account = $1${this.store.forUpdate}`, [acct]);
        const got = await t.query("SELECT coalesce(sum(amount), 0) AS s FROM ledger WHERE to_acct = $1 AND at > $3 AND kind = 'reward' AND ref = $2", [acct, period, Date.now() - 86400000]);
        const pay = Math.min(Math.floor(amount), cap - Number(got.rows[0].s));
        if (pay <= 0) return { applied: false };
        return mint(t, acct, pay, `${keyPrefix}:${acct}`, 'reward', period);
      });
      if (r.applied) paid++;
    }
    return { paid };
  }

  // Abuse signals for moderators (read-only; nothing is blocked
  // automatically - a family sharing one router looks the same as a farm):
  //  * receivers: who got the most coins from other players lately, from how
  //    many senders, and how much of it came from accounts younger than 7 days
  //    (the classic "farm alts for the starter grant, funnel to a main");
  //  * clusters: registration IPs with several accounts, and how many coins
  //    moved between accounts of the same cluster.
  async flows({ hours = 24 } = {}) {
    const now = Date.now();
    const since = now - Math.min(24 * 30, Math.max(1, Number(hours) || 24)) * 3600000;
    const young = now - 7 * 86400000;
    const r = await this.store.query(
      `SELECT l.to_acct AS acct, a.display AS name, sum(l.amount) AS received, count(DISTINCT l.from_acct) AS senders,
              sum(CASE WHEN s.created > $2 THEN l.amount ELSE 0 END) AS from_young
         FROM ledger l JOIN accounts a ON a.id = l.to_acct JOIN accounts s ON s.id = l.from_acct
        WHERE l.at > $1 AND l.from_acct > 0 AND l.to_acct > 0
        GROUP BY l.to_acct, a.display ORDER BY received DESC LIMIT 20`,
      [since, young],
    );
    const receivers = r.rows.map((x) => {
      const received = Number(x.received);
      const fromYoung = Number(x.from_young);
      const senders = Number(x.senders);
      return {
        id: Number(x.acct),
        name: x.name,
        received,
        senders,
        fromYoung,
        suspicious: senders >= 3 && fromYoung >= received * 0.5,
      };
    });
    const g = await this.store.query(
      `SELECT reg_ip, count(*) AS n FROM accounts WHERE reg_ip <> '' GROUP BY reg_ip HAVING count(*) >= 3 ORDER BY count(*) DESC LIMIT 20`,
      [],
    );
    const clusters = [];
    for (const row of g.rows) {
      const m = await this.store.query('SELECT id, display FROM accounts WHERE reg_ip = $1 ORDER BY id LIMIT 50', [row.reg_ip]);
      const inner = await this.store.query(
        `SELECT coalesce(sum(l.amount), 0) AS moved FROM ledger l
           JOIN accounts f ON f.id = l.from_acct JOIN accounts t ON t.id = l.to_acct
          WHERE f.reg_ip = $1 AND t.reg_ip = $1 AND l.at > $2`,
        [row.reg_ip, since],
      );
      clusters.push({
        accounts: Number(row.n),
        names: m.rows.map((x) => x.display),
        ids: m.rows.map((x) => Number(x.id)),
        movedInside: Number(inner.rows[0].moved),
      });
    }
    return { hours: Math.round((now - since) / 3600000), receivers, clusters };
  }

  // Totals for the admin page (and the conservation check).
  async stats() {
    const b = await this.store.query('SELECT account, amount FROM balances WHERE account < 0');
    const sys = Object.fromEntries(b.rows.map((r) => [Number(r.account), Number(r.amount)]));
    const sum = await this.store.query('SELECT coalesce(sum(amount), 0) AS s FROM balances');
    const items = await this.store.query("SELECT count(*) AS n FROM items WHERE state = 'held'");
    const listings = await this.store.query("SELECT count(*) AS n FROM listings WHERE status = 'open'");
    const minted = -(sys[-1] || 0);
    const sunk = sys[-2] || 0;
    return { minted, sunk, circulating: minted - sunk, balanceSum: Number(sum.rows[0].s), items: Number(items.rows[0].n), openListings: Number(listings.rows[0].n) };
  }
}

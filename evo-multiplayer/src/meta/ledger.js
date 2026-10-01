// Currency and item primitives. Every function here runs INSIDE a store
// transaction (`t`) supplied by the caller, so composite operations (a
// market purchase, a two-sided trade) commit or roll back as a whole.
//
// Invariants (checked by test/economy.test.js after concurrent fuzzing):
//  * every currency movement is one ledger row with a unique idempotency key;
//    replaying a key changes nothing;
//  * player balances never go below zero (conditional debit);
//  * sum(balances) over all accounts, including MINT (negative) and SINK, is 0,
//    and each balance equals its ledger in-flow minus out-flow;
//  * an item has exactly one owner, can be in at most one escrow (lock), and
//    is created at most once per source (unique source_key).

import { MINT, SINK } from './store.js';

export class AppError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const isSystem = (acct) => acct === MINT || acct === SINK;

async function adjust(t, account, delta) {
  await t.query(
    'INSERT INTO balances(account, amount) VALUES ($1, $2) ON CONFLICT (account) DO UPDATE SET amount = balances.amount + excluded.amount',
    [account, delta],
  );
}

// Moves `amount` spores. Returns { applied: false } if `key` was used before.
export async function move(t, { key, kind, from, to, amount, ref = '' }) {
  if (!Number.isInteger(amount) || amount <= 0) throw new AppError('BAD_AMOUNT', 'amount must be a positive integer');
  if (from === to) throw new AppError('BAD_TRANSFER', 'from and to are the same account');
  const ins = await t.query(
    'INSERT INTO ledger(key, at, kind, from_acct, to_acct, amount, ref) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (key) DO NOTHING RETURNING id',
    [key, Date.now(), kind, from, to, amount, ref],
  );
  if (ins.rows.length === 0) return { applied: false };
  if (isSystem(from)) await adjust(t, from, -amount);
  else {
    const r = await t.query('UPDATE balances SET amount = amount - $1 WHERE account = $2 AND amount >= $1', [amount, from]);
    if (r.count !== 1) throw new AppError('INSUFFICIENT_FUNDS', '余额不足');
  }
  await adjust(t, to, amount);
  return { applied: true, id: ins.rows[0].id };
}

export const mint = (t, to, amount, key, kind, ref) => move(t, { key, kind, from: MINT, to, amount, ref });
export const burn = (t, from, amount, key, kind, ref) => move(t, { key, kind, from, to: SINK, amount, ref });

export async function balanceOf(q, account) {
  const r = await q.query('SELECT amount FROM balances WHERE account = $1', [account]);
  return r.rows.length ? Number(r.rows[0].amount) : 0;
}

// ------------------------------------------------------------------ items

async function logItem(t, item, action, from, to, ref = '') {
  await t.query('INSERT INTO item_log(item, at, action, from_acct, to_acct, ref) VALUES ($1, $2, $3, $4, $5, $6)', [
    item,
    Date.now(),
    action,
    from,
    to,
    ref,
  ]);
}

// Creates an item once per sourceKey. Returns { id, created }.
export async function createItem(t, { owner, kind, data, sourceKey }) {
  const r = await t.query(
    'INSERT INTO items(owner, kind, data, source_key, created) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (source_key) DO NOTHING RETURNING id',
    [owner, kind, JSON.stringify(data), sourceKey, Date.now()],
  );
  if (r.rows.length === 0) {
    const ex = await t.query('SELECT id FROM items WHERE source_key = $1', [sourceKey]);
    return { id: Number(ex.rows[0].id), created: false };
  }
  const id = Number(r.rows[0].id);
  await logItem(t, id, 'create', null, owner, sourceKey);
  return { id, created: true };
}

// Puts an item the owner holds (and that is in no other escrow) into escrow.
export async function lockItem(t, id, owner, lock) {
  const r = await t.query("UPDATE items SET lock = $1 WHERE id = $2 AND owner = $3 AND state = 'held' AND lock IS NULL", [lock, id, owner]);
  if (r.count !== 1) throw new AppError('ITEM_UNAVAILABLE', `物品 ${id} 不在你手上或已被占用`);
}

export async function unlockItem(t, id, lock) {
  await t.query('UPDATE items SET lock = NULL WHERE id = $1 AND lock = $2', [id, lock]);
}

// Transfers ownership; the item must be in escrow `lock` (or free if lock is null).
export async function transferItem(t, id, from, to, lock, ref) {
  const r = lock
    ? await t.query("UPDATE items SET owner = $1, lock = NULL WHERE id = $2 AND owner = $3 AND state = 'held' AND lock = $4", [to, id, from, lock])
    : await t.query("UPDATE items SET owner = $1 WHERE id = $2 AND owner = $3 AND state = 'held' AND lock IS NULL", [to, id, from]);
  if (r.count !== 1) throw new AppError('ITEM_UNAVAILABLE', `物品 ${id} 已不可交易`);
  await logItem(t, id, 'transfer', from, to, ref);
}

// Takes an item out of circulation (e.g. released back into the world).
export async function consumeItem(t, id, owner, ref) {
  const r = await t.query("UPDATE items SET state = 'released' WHERE id = $1 AND owner = $2 AND state = 'held' AND lock IS NULL", [id, owner]);
  if (r.count !== 1) throw new AppError('ITEM_UNAVAILABLE', `物品 ${id} 不在你手上或已被占用`);
  await logItem(t, id, 'consume', owner, null, ref);
}

export async function itemsOf(q, owner) {
  const r = await q.query("SELECT id, kind, data, lock, created FROM items WHERE owner = $1 AND state = 'held' ORDER BY id DESC LIMIT 500", [owner]);
  return r.rows.map((x) => ({ id: Number(x.id), kind: x.kind, data: JSON.parse(x.data), lock: x.lock, created: Number(x.created) }));
}

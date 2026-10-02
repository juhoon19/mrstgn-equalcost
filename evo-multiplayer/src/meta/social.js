// Persistent social graph and messages: friend requests, blocks, private
// messages (stored, deliverable offline, with read state), privacy setting,
// player reports and the moderation audit log.
// Live presence and delivery are in meta-node.js; this file is storage + rules.

import { AppError } from './ledger.js';

export const MAX_FRIENDS = 500;
export const DM_MAX_LEN = 500;
export const DM_PER_MINUTE = 20;
export const NEW_CONVERSATIONS_PER_HOUR = 10;
export const FRIEND_REQUESTS_PER_HOUR = 30;

const pair = (x, y) => (x < y ? [x, y] : [y, x]);
const int = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError('BAD_ARG', `${name} must be a positive integer`);
  return n;
};

export class Social {
  constructor(store) {
    this.store = store;
    this.dmRate = new Map(); // account -> [t]
    this.newConv = new Map(); // account -> [t]
  }

  // --------------------------------------------------------------- friends

  async isBlocked(a, b) {
    const r = await this.store.query('SELECT 1 FROM blocks WHERE (account = $1 AND target = $2) OR (account = $2 AND target = $1)', [a, b]);
    return r.rows.length > 0;
  }

  async areFriends(a, b) {
    const [x, y] = pair(a, b);
    const r = await this.store.query("SELECT 1 FROM friends WHERE a = $1 AND b = $2 AND status = 'accepted'", [x, y]);
    return r.rows.length > 0;
  }

  // Sends a request, or accepts if the other side already asked.
  async request(from, to) {
    to = int(to, 'to');
    if (from === to) throw new AppError('BAD_ARG', '不能加自己');
    if (await this.isBlocked(from, to)) throw new AppError('BLOCKED', '无法添加该玩家');
    // Each request pushes a notification to the target: cap them (calls for
    // one account always reach its home replica, so this count is complete).
    if (!this.rate(this.newConv, `friend:${from}`, 3600000, FRIEND_REQUESTS_PER_HOUR)) throw new AppError('RATE', `每小时最多发 ${FRIEND_REQUESTS_PER_HOUR} 个好友申请`);
    const exists = await this.store.query('SELECT id FROM accounts WHERE id = $1', [to]);
    if (!exists.rows.length) throw new AppError('NOT_FOUND', '没有这个玩家');
    const [x, y] = pair(from, to);
    return this.store.tx(async (t) => {
      const cnt = await t.query("SELECT count(*) AS n FROM friends WHERE (a = $1 OR b = $1) AND status = 'accepted'", [from]);
      if (Number(cnt.rows[0].n) >= MAX_FRIENDS) throw new AppError('TOO_MANY', `好友上限 ${MAX_FRIENDS}`);
      const cur = await t.query(`SELECT status, requester FROM friends WHERE a = $1 AND b = $2${this.store.forUpdate}`, [x, y]);
      const row = cur.rows[0];
      if (row?.status === 'accepted') return { status: 'accepted', changed: false };
      if (row && Number(row.requester) === to) {
        await t.query("UPDATE friends SET status = 'accepted' WHERE a = $1 AND b = $2", [x, y]);
        return { status: 'accepted', changed: true };
      }
      if (row) return { status: 'pending', changed: false };
      await t.query("INSERT INTO friends(a, b, status, requester, created) VALUES ($1, $2, 'pending', $3, $4)", [x, y, from, Date.now()]);
      return { status: 'pending', changed: true };
    });
  }

  async respond(me, other, accept) {
    other = int(other, 'from');
    const [x, y] = pair(me, other);
    if (accept) {
      const r = await this.store.query("UPDATE friends SET status = 'accepted' WHERE a = $1 AND b = $2 AND status = 'pending' AND requester = $3", [x, y, other]);
      if (r.count !== 1) throw new AppError('NOT_FOUND', '没有这条好友申请');
      return { status: 'accepted' };
    }
    await this.store.query("DELETE FROM friends WHERE a = $1 AND b = $2 AND status = 'pending'", [x, y]);
    return { status: 'declined' };
  }

  async remove(me, other) {
    const [x, y] = pair(me, int(other, 'id'));
    await this.store.query('DELETE FROM friends WHERE a = $1 AND b = $2', [x, y]);
  }

  // [{ id, name, status: 'accepted'|'incoming'|'outgoing' }]
  async list(me) {
    const r = await this.store.query(
      `SELECT f.a, f.b, f.status, f.requester, acc.id AS other, acc.display AS name
         FROM friends f JOIN accounts acc ON acc.id = CASE WHEN f.a = $1 THEN f.b ELSE f.a END
        WHERE f.a = $1 OR f.b = $1 ORDER BY acc.display`,
      [me],
    );
    return r.rows.map((x) => ({
      id: Number(x.other),
      name: x.name,
      status: x.status === 'accepted' ? 'accepted' : Number(x.requester) === me ? 'outgoing' : 'incoming',
    }));
  }

  async friendIds(me) {
    const r = await this.store.query("SELECT a, b FROM friends WHERE (a = $1 OR b = $1) AND status = 'accepted'", [me]);
    return r.rows.map((x) => (Number(x.a) === me ? Number(x.b) : Number(x.a)));
  }

  async block(me, target) {
    target = int(target, 'id');
    if (me === target) throw new AppError('BAD_ARG', '不能屏蔽自己');
    const [x, y] = pair(me, target);
    await this.store.tx(async (t) => {
      await t.query('INSERT INTO blocks(account, target, created) VALUES ($1, $2, $3) ON CONFLICT (account, target) DO NOTHING', [me, target, Date.now()]);
      await t.query('DELETE FROM friends WHERE a = $1 AND b = $2', [x, y]);
      await t.query("UPDATE trades SET status = 'cancelled', updated = $3 WHERE status = 'open' AND ((a = $1 AND b = $2) OR (a = $2 AND b = $1))", [me, target, Date.now()]);
    });
  }

  async unblock(me, target) {
    await this.store.query('DELETE FROM blocks WHERE account = $1 AND target = $2', [me, int(target, 'id')]);
  }

  async blocks(me) {
    const r = await this.store.query('SELECT b.target AS id, a.display AS name FROM blocks b JOIN accounts a ON a.id = b.target WHERE b.account = $1', [me]);
    return r.rows.map((x) => ({ id: Number(x.id), name: x.name }));
  }

  // -------------------------------------------------------------- messages

  rate(map, key, windowMs, max) {
    const now = Date.now();
    const list = (map.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return false;
    list.push(now);
    map.set(key, list);
    if (map.size > 200000) map.clear();
    return true;
  }

  // Checks every rule for `from` messaging `to`; returns { friends }.
  async canMessage(from, to, mutedUntil) {
    if (from === to) throw new AppError('BAD_ARG', '不能给自己发消息');
    if (mutedUntil > Date.now()) throw new AppError('MUTED', `你已被禁言至 ${new Date(mutedUntil).toLocaleString()}`);
    const r = await this.store.query('SELECT privacy_dm FROM accounts WHERE id = $1', [to]);
    if (!r.rows.length) throw new AppError('NOT_FOUND', '没有这个玩家');
    if (await this.isBlocked(from, to)) throw new AppError('BLOCKED', '对方不接收你的消息');
    const friends = await this.areFriends(from, to);
    const privacy = r.rows[0].privacy_dm;
    if (privacy === 'nobody' || (privacy === 'friends' && !friends)) throw new AppError('PRIVACY', '对方只接收好友的消息');
    if (!this.rate(this.dmRate, from, 60000, DM_PER_MINUTE)) throw new AppError('RATE', '发送太快了');
    if (!friends) {
      const prior = await this.store.query('SELECT 1 FROM messages WHERE from_acct = $1 AND to_acct = $2 LIMIT 1', [from, to]);
      if (!prior.rows.length && !this.rate(this.newConv, from, 3600000, NEW_CONVERSATIONS_PER_HOUR)) {
        throw new AppError('RATE', '每小时最多主动联系 10 位陌生人');
      }
    }
    return { friends };
  }

  async storeMessage(from, to, text, flagged = '') {
    const at = Date.now();
    const r = await this.store.query('INSERT INTO messages(from_acct, to_acct, text, at, flagged) VALUES ($1, $2, $3, $4, $5) RETURNING id', [
      from,
      to,
      text.slice(0, DM_MAX_LEN),
      at,
      flagged,
    ]);
    return { id: Number(r.rows[0].id), from, to, text: text.slice(0, DM_MAX_LEN), at };
  }

  async history(me, other, before = 0, limit = 50) {
    other = int(other, 'with');
    const r = await this.store.query(
      `SELECT id, from_acct, to_acct, text, at FROM messages
        WHERE ((from_acct = $1 AND to_acct = $2) OR (from_acct = $2 AND to_acct = $1)) AND ($3 = 0 OR id < $3)
        ORDER BY id DESC LIMIT $4`,
      [me, other, Number(before) || 0, Math.min(100, Number(limit) || 50)],
    );
    return r.rows.reverse().map((x) => ({ id: Number(x.id), from: Number(x.from_acct), to: Number(x.to_acct), text: x.text, at: Number(x.at) }));
  }

  async unread(me) {
    const r = await this.store.query(
      `SELECT m.from_acct AS id, a.display AS name, count(*) AS n FROM messages m JOIN accounts a ON a.id = m.from_acct
        WHERE m.to_acct = $1 AND m.read = 0 GROUP BY m.from_acct, a.display`,
      [me],
    );
    return r.rows.map((x) => ({ id: Number(x.id), name: x.name, n: Number(x.n) }));
  }

  async markRead(me, other) {
    await this.store.query('UPDATE messages SET read = 1 WHERE to_acct = $1 AND from_acct = $2 AND read = 0', [me, int(other, 'with')]);
  }

  // --------------------------------------------------------------- reports

  async report(reporter, target, reason) {
    target = int(target, 'target');
    if (reporter === target) throw new AppError('BAD_ARG', '不能举报自己');
    if (!this.rate(this.newConv, `report:${reporter}`, 3600000, 20)) throw new AppError('RATE', '举报太频繁');
    // Evidence comes from the server's own records, not from the client.
    const ctx = await this.store.query(
      `SELECT from_acct, to_acct, text, at FROM messages
        WHERE (from_acct = $1 AND to_acct = $2) OR (from_acct = $2 AND to_acct = $1) ORDER BY id DESC LIMIT 30`,
      [reporter, target],
    );
    const r = await this.store.query('INSERT INTO reports(reporter, target, reason, context, at) VALUES ($1, $2, $3, $4, $5) RETURNING id', [
      reporter,
      target,
      String(reason ?? '').slice(0, 500),
      JSON.stringify(ctx.rows.reverse().map((m) => ({ from: Number(m.from_acct), text: m.text, at: Number(m.at) }))),
      Date.now(),
    ]);
    return { report: Number(r.rows[0].id) };
  }

  async reports(status = 'open', limit = 100) {
    const r = await this.store.query(
      `SELECT r.*, a.display AS reporter_name, b.display AS target_name FROM reports r
         JOIN accounts a ON a.id = r.reporter JOIN accounts b ON b.id = r.target
        WHERE r.status = $1 ORDER BY r.id DESC LIMIT $2`,
      [status, limit],
    );
    return r.rows.map((x) => ({
      id: Number(x.id),
      reporter: Number(x.reporter),
      reporterName: x.reporter_name,
      target: Number(x.target),
      targetName: x.target_name,
      reason: x.reason,
      context: JSON.parse(x.context),
      at: Number(x.at),
      status: x.status,
      note: x.note,
    }));
  }

  async closeReport(id, actor, note) {
    await this.store.query("UPDATE reports SET status = 'closed', handled_by = $1, note = $2 WHERE id = $3", [actor, String(note ?? '').slice(0, 500), int(id, 'id')]);
  }

  async audit(actor, action, target, detail) {
    await this.store.query('INSERT INTO audit(actor, action, target, detail, at) VALUES ($1, $2, $3, $4, $5)', [
      actor,
      action,
      String(target ?? ''),
      typeof detail === 'string' ? detail : JSON.stringify(detail ?? ''),
      Date.now(),
    ]);
  }

  async auditLog(limit = 200) {
    const r = await this.store.query('SELECT x.*, a.display AS actor_name FROM audit x LEFT JOIN accounts a ON a.id = x.actor ORDER BY x.id DESC LIMIT $1', [limit]);
    return r.rows.map((x) => ({ id: Number(x.id), actor: Number(x.actor), actorName: x.actor_name ?? (Number(x.actor) === 0 ? '系统' : '?'), action: x.action, target: x.target, detail: x.detail, at: Number(x.at) }));
  }
}

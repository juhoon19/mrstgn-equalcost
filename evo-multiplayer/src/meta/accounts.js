// Accounts: registration, login, sessions, optional TOTP 2FA, recovery codes
// and roles. Anything of value (currency, items, friends) belongs to an
// account; guests can still play the world but cannot trade or befriend.
//
// Security notes:
//  * passwords: scrypt (N=2^14, r=8, p=1) with a per-account salt;
//  * session tokens: 32 random bytes; only their SHA-256 is stored, so a
//    database leak does not hand out live sessions; 30-day expiry, revocable;
//  * login throttling per username and per IP (10 failures / 10 min);
//  * TOTP replay protection (a code works once);
//  * recovery codes are shown once and stored hashed.

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { AppError, mint } from './ledger.js';
import { newSecret, verifyTotp, otpauthUri } from './totp.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 30 * 24 * 3600 * 1000;
const CACHE_MS = 5000;
export const STARTER_GRANT = 100;
export const ROLES = ['player', 'mod', 'admin'];

const sha = (s) => crypto.createHash('sha256').update(s).digest('base64url');

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function checkPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = await scrypt(pw, Buffer.from(salt, 'base64url'), 32, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  const want = Buffer.from(hash, 'base64url');
  return want.length === key.length && crypto.timingSafeEqual(key, want);
}

function validName(name) {
  return typeof name === 'string' && /^[\p{L}\p{N}_]{2,20}$/u.test(name);
}

function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 200;
}

export function publicAccount(a) {
  return {
    id: Number(a.id),
    name: a.display,
    role: a.role,
    hue: Number(a.hue),
    totp: !!Number(a.totp_enabled),
    privacyDm: a.privacy_dm,
    mutedUntil: Number(a.muted_until),
  };
}

export class Accounts {
  // registerPerHour: accounts one IP may create per hour (all replicas
  // share the count: it lives in the database, like the login throttle and
  // the TOTP replay guard).
  constructor(store, { log = () => {}, registerPerHour = 5, pepper = '' } = {}) {
    this.store = store;
    this.log = log;
    this.registerPerHour = registerPerHour;
    this.cache = new Map(); // id -> { a, t }
    // Invalidate again once a write has finished (a read racing the write
    // could otherwise re-cache the old row).
    for (const m of ['totpSetup', 'totpEnable', 'totpDisable', 'setPrivacy', 'setRole', 'setSanction']) {
      const f = this[m].bind(this);
      this[m] = async (id, ...rest) => {
        try {
          return await f(id, ...rest);
        } finally {
          this.invalidate(id);
        }
      };
    }
    this.pepper = pepper;
  }

  ipKey(ip) {
    return ip ? sha(`${this.pepper}:${ip}`).slice(0, 22) : '';
  }

  // Failed attempts within 10 minutes, counted per IP ("i:"), per name+IP
  // ("n:") and per name ("u:"). One IP is locked after 10 failures overall
  // or 10 on one name. The per-name count must NOT lock the name for
  // everyone (anyone could then lock any player, staff included, out of
  // their account with 10 wrong passwords): once a name has had 100 failures
  // from anywhere, only IPs that already failed on it are refused, so the
  // owner on their own network still gets in, and a botnet gets one guess
  // per address.
  async throttled(keys) {
    const r = await this.store.query(`SELECT key, n, t FROM throttle WHERE key IN (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, keys);
    const now = Date.now();
    const n = {};
    for (const f of r.rows) if (now - Number(f.t) < 10 * 60000) n[f.key[0]] = Number(f.n);
    return (n.i || 0) >= 10 || (n.n || 0) >= 10 || ((n.u || 0) >= 100 && (n.n || 0) >= 1);
  }

  async noteFail(keys) {
    const now = Date.now();
    for (const k of keys) {
      await this.store.query(
        `INSERT INTO throttle(key, n, t) VALUES ($1, 1, $2)
         ON CONFLICT (key) DO UPDATE SET n = CASE WHEN throttle.t > $3 THEN throttle.n + 1 ELSE 1 END, t = $2`,
        [k, now, now - 10 * 60000],
      );
    }
  }

  throttleKeys(name, ip) {
    const lc = String(name ?? '').toLowerCase();
    const h = this.ipKey(ip);
    return [`u:${lc}`, `i:${h}`, `n:${lc}:${h}`];
  }

  async newSession(t, accountId, ua) {
    const token = 'S' + crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    await t.query('INSERT INTO sessions(token_hash, account, created, last_seen, expires, ua) VALUES ($1, $2, $3, $3, $4, $5)', [
      sha(token),
      accountId,
      now,
      now + SESSION_MS,
      String(ua ?? '').slice(0, 200),
    ]);
    return token;
  }

  async register({ name, password, hue = Math.random(), ua = '', ip = '' }) {
    if (!validName(name)) throw new AppError('BAD_NAME', '名字需为 2–20 个字母、数字、汉字或下划线');
    if (!validPassword(password)) throw new AppError('BAD_PASSWORD', '密码至少 8 位');
    const regIp = this.ipKey(ip);
    if (regIp && this.registerPerHour > 0) {
      const r = await this.store.query('SELECT count(*) AS n FROM accounts WHERE reg_ip = $1 AND created > $2', [regIp, Date.now() - 3600000]);
      if (Number(r.rows[0].n) >= this.registerPerHour) throw new AppError('RATE', '这个网络注册太频繁，请稍后再试');
    }
    const pass = await hashPassword(password);
    const codes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex'));
    return this.store.tx(async (t) => {
      const r = await t.query(
        'INSERT INTO accounts(name_lc, display, pass, hue, recovery, created, reg_ip) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (name_lc) DO NOTHING RETURNING *',
        [name.toLowerCase(), name, pass, Number(hue) || 0, JSON.stringify(codes.map(sha)), Date.now(), regIp],
      );
      if (r.rows.length === 0) throw new AppError('NAME_TAKEN', '这个名字已被注册');
      const acct = r.rows[0];
      await mint(t, Number(acct.id), STARTER_GRANT, `starter:${acct.id}`, 'starter');
      const token = await this.newSession(t, acct.id, ua);
      return { account: publicAccount(acct), token, recoveryCodes: codes };
    });
  }

  async login({ name, password, totp, ua = '', ip = '' }) {
    const keys = this.throttleKeys(name, ip);
    if (await this.throttled(keys)) throw new AppError('THROTTLED', '尝试次数过多，请 10 分钟后再试');
    const r = await this.store.query('SELECT * FROM accounts WHERE name_lc = $1', [String(name ?? '').toLowerCase()]);
    const acct = r.rows[0];
    // Run scrypt even for unknown names so timing does not reveal which exist.
    const ok = await checkPassword(String(password ?? ''), acct ? acct.pass : 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA');
    if (!acct || !ok) {
      await this.noteFail(keys);
      throw new AppError('BAD_LOGIN', '用户名或密码错误');
    }
    if (Number(acct.banned_until) > Date.now()) throw new AppError('BANNED', '账号已被封禁');
    if (Number(acct.totp_enabled)) {
      if (!totp) throw new AppError('TOTP_REQUIRED', '请输入两步验证码');
      if (!(await this.checkTotp(acct, totp))) {
        await this.noteFail(keys);
        throw new AppError('BAD_TOTP', '验证码错误');
      }
    }
    const token = await this.store.tx((t) => this.newSession(t, acct.id, ua));
    return { account: publicAccount(acct), token };
  }

  // A code is accepted once: the used time step is recorded with a
  // conditional update, so a replay fails on every replica.
  async checkTotp(acct, code) {
    const step = verifyTotp(acct.totp_secret, code);
    if (step < 0) return false;
    const r = await this.store.query('UPDATE accounts SET totp_last = $1 WHERE id = $2 AND totp_last < $1', [step, Number(acct.id)]);
    return r.count === 1;
  }

  // Session token -> account (or null). Touches last_seen at most once a minute.
  async resume(token) {
    if (typeof token !== 'string' || !token.startsWith('S')) return null;
    const h = sha(token);
    const r = await this.store.query(
      'SELECT a.*, s.expires, s.last_seen FROM sessions s JOIN accounts a ON a.id = s.account WHERE s.token_hash = $1',
      [h],
    );
    const row = r.rows[0];
    if (!row || Number(row.expires) < Date.now()) return null;
    if (Number(row.banned_until) > Date.now()) throw new AppError('BANNED', '账号已被封禁');
    if (Date.now() - Number(row.last_seen) > 60000) {
      await this.store.query('UPDATE sessions SET last_seen = $1 WHERE token_hash = $2', [Date.now(), h]);
    }
    return publicAccount(row);
  }

  // Read on almost every request (DMs, presence, staff checks): cached for
  // CACHE_MS. Changes made through this replica invalidate at once; a change
  // made on another replica (a mute, a role) applies here within CACHE_MS -
  // and sanctions are also pushed to the account's home replica, which
  // invalidates on delivery (see meta-node deliver()).
  async get(id) {
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.t < CACHE_MS) return hit.a;
    const r = await this.store.query('SELECT * FROM accounts WHERE id = $1', [id]);
    const a = r.rows[0] ? publicAccount(r.rows[0]) : null;
    if (a) {
      if (this.cache.size > 100000) this.cache.clear();
      this.cache.set(id, { a, t: Date.now() });
    }
    return a;
  }

  invalidate(id) {
    this.cache.delete(Number(id));
  }

  async byName(name) {
    const r = await this.store.query('SELECT * FROM accounts WHERE name_lc = $1', [String(name ?? '').toLowerCase()]);
    return r.rows[0] ? publicAccount(r.rows[0]) : null;
  }

  async logout(token) {
    await this.store.query('DELETE FROM sessions WHERE token_hash = $1', [sha(String(token))]);
  }

  async logoutAll(accountId) {
    await this.store.query('DELETE FROM sessions WHERE account = $1', [accountId]);
  }

  async sessions(accountId) {
    const r = await this.store.query('SELECT created, last_seen, expires, ua FROM sessions WHERE account = $1 ORDER BY last_seen DESC', [accountId]);
    return r.rows.map((s) => ({ created: Number(s.created), lastSeen: Number(s.last_seen), expires: Number(s.expires), ua: s.ua }));
  }

  async changePassword(accountId, oldPw, newPw) {
    if (!validPassword(newPw)) throw new AppError('BAD_PASSWORD', '密码至少 8 位');
    // A stolen session must not be able to guess the old password freely.
    const keys = [`i:pw:${accountId}`];
    if (await this.throttled(keys)) throw new AppError('THROTTLED', '尝试次数过多，请 10 分钟后再试');
    const r = await this.store.query('SELECT pass FROM accounts WHERE id = $1', [accountId]);
    if (!r.rows[0] || !(await checkPassword(String(oldPw ?? ''), r.rows[0].pass))) {
      await this.noteFail(keys);
      throw new AppError('BAD_LOGIN', '原密码错误');
    }
    await this.store.query('UPDATE accounts SET pass = $1 WHERE id = $2', [await hashPassword(newPw), accountId]);
    await this.logoutAll(accountId); // everywhere else must log in again
  }

  // Reset with a one-time recovery code; revokes every session.
  async recover({ name, code, newPassword, ua = '', ip = '' }) {
    const keys = this.throttleKeys(name, ip);
    if (await this.throttled(keys)) throw new AppError('THROTTLED', '尝试次数过多，请 10 分钟后再试');
    if (!validPassword(newPassword)) throw new AppError('BAD_PASSWORD', '密码至少 8 位');
    const pass = await hashPassword(newPassword);
    // The failure is recorded after the transaction (SQLite has one
    // connection: a write inside the transaction's callback would wait on it).
    return this.store.tx(async (t) => {
      const r = await t.query(`SELECT * FROM accounts WHERE name_lc = $1${this.store.forUpdate}`, [String(name ?? '').toLowerCase()]);
      const acct = r.rows[0];
      const codes = acct ? JSON.parse(acct.recovery) : [];
      const i = codes.indexOf(sha(String(code ?? '').trim()));
      if (!acct || i < 0) throw new AppError('BAD_RECOVERY', '恢复码无效');
      codes.splice(i, 1);
      await t.query('UPDATE accounts SET pass = $1, recovery = $2, totp_enabled = 0 WHERE id = $3', [pass, JSON.stringify(codes), acct.id]);
      await t.query('DELETE FROM sessions WHERE account = $1', [acct.id]);
      const token = await this.newSession(t, acct.id, ua);
      return { account: publicAccount({ ...acct, totp_enabled: 0 }), token, codesLeft: codes.length };
    }).catch(async (err) => {
      if (err.code === 'BAD_RECOVERY') await this.noteFail(keys);
      throw err;
    });
  }

  async totpSetup(accountId) {
    this.invalidate(accountId);
    const secret = newSecret();
    const a = await this.store.query('SELECT display, totp_enabled FROM accounts WHERE id = $1', [accountId]);
    // Replacing an active secret would switch 2FA off without a code: a stolen
    // session could then strip 2FA (or lock the owner out with its own).
    if (Number(a.rows[0]?.totp_enabled)) throw new AppError('TOTP_ENABLED', '两步验证已开启；要更换，请先用验证码关闭');
    await this.store.query('UPDATE accounts SET totp_secret = $1, totp_enabled = 0, totp_last = -1 WHERE id = $2', [secret, accountId]);
    return { secret, uri: otpauthUri(secret, a.rows[0]?.display ?? String(accountId)) };
  }

  async totpEnable(accountId, code) {
    this.invalidate(accountId);
    const r = await this.store.query('SELECT * FROM accounts WHERE id = $1', [accountId]);
    const acct = r.rows[0];
    if (!acct?.totp_secret || !(await this.checkTotp(acct, code))) throw new AppError('BAD_TOTP', '验证码错误');
    await this.store.query('UPDATE accounts SET totp_enabled = 1 WHERE id = $1', [accountId]);
  }

  async totpDisable(accountId, code) {
    this.invalidate(accountId);
    const r = await this.store.query('SELECT * FROM accounts WHERE id = $1', [accountId]);
    const acct = r.rows[0];
    if (!Number(acct?.totp_enabled) || !(await this.checkTotp(acct, code))) throw new AppError('BAD_TOTP', '验证码错误');
    await this.store.query('UPDATE accounts SET totp_enabled = 0, totp_secret = NULL WHERE id = $1', [accountId]);
  }

  async setPrivacy(accountId, dm) {
    this.invalidate(accountId);
    if (!['everyone', 'friends', 'nobody'].includes(dm)) throw new AppError('BAD_ARG', 'privacy must be everyone|friends|nobody');
    await this.store.query('UPDATE accounts SET privacy_dm = $1 WHERE id = $2', [dm, accountId]);
  }

  async setRole(accountId, role) {
    this.invalidate(accountId);
    if (!ROLES.includes(role)) throw new AppError('BAD_ARG', `role must be one of ${ROLES}`);
    await this.store.query('UPDATE accounts SET role = $1 WHERE id = $2', [role, accountId]);
  }

  async setSanction(accountId, { mutedUntil, bannedUntil }) {
    this.invalidate(accountId);
    if (mutedUntil !== undefined) await this.store.query('UPDATE accounts SET muted_until = $1 WHERE id = $2', [mutedUntil, accountId]);
    if (bannedUntil !== undefined) {
      await this.store.query('UPDATE accounts SET banned_until = $1 WHERE id = $2', [bannedUntil, accountId]);
      if (bannedUntil > Date.now()) await this.logoutAll(accountId);
    }
  }
}

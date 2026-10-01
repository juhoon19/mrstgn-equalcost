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
  constructor(store, { log = () => {} } = {}) {
    this.store = store;
    this.log = log;
    this.fails = new Map(); // "u:name" / "i:ip" -> { n, t }
    this.usedTotp = new Map(); // account -> last used step
  }

  throttled(keys) {
    const now = Date.now();
    return keys.some((k) => {
      const f = this.fails.get(k);
      return f && f.n >= 10 && now - f.t < 10 * 60000;
    });
  }

  noteFail(keys) {
    const now = Date.now();
    for (const k of keys) {
      const f = this.fails.get(k);
      this.fails.set(k, { n: f && now - f.t < 10 * 60000 ? f.n + 1 : 1, t: now });
    }
    if (this.fails.size > 100000) this.fails.clear();
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

  async register({ name, password, hue = Math.random(), ua = '' }) {
    if (!validName(name)) throw new AppError('BAD_NAME', '名字需为 2–20 个字母、数字、汉字或下划线');
    if (!validPassword(password)) throw new AppError('BAD_PASSWORD', '密码至少 8 位');
    const pass = await hashPassword(password);
    const codes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex'));
    return this.store.tx(async (t) => {
      const r = await t.query(
        'INSERT INTO accounts(name_lc, display, pass, hue, recovery, created) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (name_lc) DO NOTHING RETURNING *',
        [name.toLowerCase(), name, pass, Number(hue) || 0, JSON.stringify(codes.map(sha)), Date.now()],
      );
      if (r.rows.length === 0) throw new AppError('NAME_TAKEN', '这个名字已被注册');
      const acct = r.rows[0];
      await mint(t, Number(acct.id), STARTER_GRANT, `starter:${acct.id}`, 'starter');
      const token = await this.newSession(t, acct.id, ua);
      return { account: publicAccount(acct), token, recoveryCodes: codes };
    });
  }

  async login({ name, password, totp, ua = '', ip = '' }) {
    const keys = [`u:${String(name).toLowerCase()}`, `i:${ip}`];
    if (this.throttled(keys)) throw new AppError('THROTTLED', '尝试次数过多，请 10 分钟后再试');
    const r = await this.store.query('SELECT * FROM accounts WHERE name_lc = $1', [String(name ?? '').toLowerCase()]);
    const acct = r.rows[0];
    // Run scrypt even for unknown names so timing does not reveal which exist.
    const ok = await checkPassword(String(password ?? ''), acct ? acct.pass : 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA');
    if (!acct || !ok) {
      this.noteFail(keys);
      throw new AppError('BAD_LOGIN', '用户名或密码错误');
    }
    if (Number(acct.banned_until) > Date.now()) throw new AppError('BANNED', '账号已被封禁');
    if (Number(acct.totp_enabled)) {
      if (!totp) throw new AppError('TOTP_REQUIRED', '请输入两步验证码');
      if (!this.checkTotp(acct, totp)) {
        this.noteFail(keys);
        throw new AppError('BAD_TOTP', '验证码错误');
      }
    }
    const token = await this.store.tx((t) => this.newSession(t, acct.id, ua));
    return { account: publicAccount(acct), token };
  }

  checkTotp(acct, code) {
    const step = verifyTotp(acct.totp_secret, code);
    if (step < 0) return false;
    const id = Number(acct.id);
    if ((this.usedTotp.get(id) ?? -1) >= step) return false; // replay
    this.usedTotp.set(id, step);
    return true;
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

  async get(id) {
    const r = await this.store.query('SELECT * FROM accounts WHERE id = $1', [id]);
    return r.rows[0] ? publicAccount(r.rows[0]) : null;
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
    const r = await this.store.query('SELECT pass FROM accounts WHERE id = $1', [accountId]);
    if (!r.rows[0] || !(await checkPassword(String(oldPw ?? ''), r.rows[0].pass))) throw new AppError('BAD_LOGIN', '原密码错误');
    await this.store.query('UPDATE accounts SET pass = $1 WHERE id = $2', [await hashPassword(newPw), accountId]);
    await this.logoutAll(accountId); // everywhere else must log in again
  }

  // Reset with a one-time recovery code; revokes every session.
  async recover({ name, code, newPassword, ua = '', ip = '' }) {
    const keys = [`u:${String(name).toLowerCase()}`, `i:${ip}`];
    if (this.throttled(keys)) throw new AppError('THROTTLED', '尝试次数过多，请 10 分钟后再试');
    if (!validPassword(newPassword)) throw new AppError('BAD_PASSWORD', '密码至少 8 位');
    const pass = await hashPassword(newPassword);
    return this.store.tx(async (t) => {
      const r = await t.query(`SELECT * FROM accounts WHERE name_lc = $1${this.store.forUpdate}`, [String(name ?? '').toLowerCase()]);
      const acct = r.rows[0];
      const codes = acct ? JSON.parse(acct.recovery) : [];
      const i = codes.indexOf(sha(String(code ?? '').trim()));
      if (!acct || i < 0) {
        this.noteFail(keys);
        throw new AppError('BAD_RECOVERY', '恢复码无效');
      }
      codes.splice(i, 1);
      await t.query('UPDATE accounts SET pass = $1, recovery = $2, totp_enabled = 0 WHERE id = $3', [pass, JSON.stringify(codes), acct.id]);
      await t.query('DELETE FROM sessions WHERE account = $1', [acct.id]);
      const token = await this.newSession(t, acct.id, ua);
      return { account: publicAccount({ ...acct, totp_enabled: 0 }), token, codesLeft: codes.length };
    });
  }

  async totpSetup(accountId) {
    const secret = newSecret();
    const a = await this.store.query('SELECT display FROM accounts WHERE id = $1', [accountId]);
    await this.store.query('UPDATE accounts SET totp_secret = $1, totp_enabled = 0 WHERE id = $2', [secret, accountId]);
    return { secret, uri: otpauthUri(secret, a.rows[0]?.display ?? String(accountId)) };
  }

  async totpEnable(accountId, code) {
    const r = await this.store.query('SELECT * FROM accounts WHERE id = $1', [accountId]);
    const acct = r.rows[0];
    if (!acct?.totp_secret || !this.checkTotp(acct, code)) throw new AppError('BAD_TOTP', '验证码错误');
    await this.store.query('UPDATE accounts SET totp_enabled = 1 WHERE id = $1', [accountId]);
  }

  async totpDisable(accountId, code) {
    const r = await this.store.query('SELECT * FROM accounts WHERE id = $1', [accountId]);
    const acct = r.rows[0];
    if (!Number(acct?.totp_enabled) || !this.checkTotp(acct, code)) throw new AppError('BAD_TOTP', '验证码错误');
    await this.store.query('UPDATE accounts SET totp_enabled = 0, totp_secret = NULL WHERE id = $1', [accountId]);
  }

  async setPrivacy(accountId, dm) {
    if (!['everyone', 'friends', 'nobody'].includes(dm)) throw new AppError('BAD_ARG', 'privacy must be everyone|friends|nobody');
    await this.store.query('UPDATE accounts SET privacy_dm = $1 WHERE id = $2', [dm, accountId]);
  }

  async setRole(accountId, role) {
    if (!ROLES.includes(role)) throw new AppError('BAD_ARG', `role must be one of ${ROLES}`);
    await this.store.query('UPDATE accounts SET role = $1 WHERE id = $2', [role, accountId]);
  }

  async setSanction(accountId, { mutedUntil, bannedUntil }) {
    if (mutedUntil !== undefined) await this.store.query('UPDATE accounts SET muted_until = $1 WHERE id = $2', [mutedUntil, accountId]);
    if (bannedUntil !== undefined) {
      await this.store.query('UPDATE accounts SET banned_until = $1 WHERE id = $2', [bannedUntil, accountId]);
      if (bannedUntil > Date.now()) await this.logoutAll(accountId);
    }
  }
}

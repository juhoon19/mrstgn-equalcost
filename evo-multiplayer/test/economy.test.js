// Economy invariants under concurrency, on SQLite and (if available)
// PostgreSQL. Set TEST_DATABASE_URL=postgres://... to include Postgres.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, SCHEMA_VERSION } from '../src/meta/store.js';
import { Accounts, STARTER_GRANT } from '../src/meta/accounts.js';
import { Economy, MARKET_FEE, RELEASE_FEE, CAPTURES_PER_DAY } from '../src/meta/economy.js';
import { mint, move } from '../src/meta/ledger.js';
import { hotp, totp, verifyTotp, base32Encode } from '../src/meta/totp.js';

const urls = ['sqlite::memory:'];
if (process.env.TEST_DATABASE_URL) urls.push(process.env.TEST_DATABASE_URL);

async function freshPg(url) {
  // Isolate each run in its own schema-free database state.
  const s = await openStore(url);
  await s.exec('TRUNCATE accounts, sessions, balances, ledger, items, item_log, listings, trades, friends, blocks, messages, reports, audit, throttle RESTART IDENTITY');
  return s;
}

async function invariants(store) {
  const bal = await store.query('SELECT account, amount FROM balances');
  let sum = 0;
  for (const r of bal.rows) {
    const a = Number(r.account);
    const amt = Number(r.amount);
    sum += amt;
    if (a > 0) assert.ok(amt >= 0, `negative balance ${a}: ${amt}`);
    const flow = await store.query(
      'SELECT coalesce((SELECT sum(amount) FROM ledger WHERE to_acct = $1), 0) - coalesce((SELECT sum(amount) FROM ledger WHERE from_acct = $1), 0) AS f',
      [a],
    );
    assert.equal(Number(flow.rows[0].f), amt, `balance of ${a} != ledger flow`);
  }
  assert.equal(sum, 0, 'currency created or destroyed outside MINT/SINK');
  const dupLock = await store.query("SELECT lock, count(*) AS n FROM items WHERE lock IS NOT NULL GROUP BY lock HAVING count(*) > 1");
  assert.equal(dupLock.rows.length, 0, 'an escrow holds two items');
  const sold = await store.query("SELECT item, count(*) AS n FROM listings WHERE status = 'sold' GROUP BY item, buyer HAVING count(*) > 1");
  assert.equal(sold.rows.length, 0);
  // Every open listing's item is locked by exactly that listing.
  const open = await store.query("SELECT l.id, i.lock, i.owner, l.seller FROM listings l JOIN items i ON i.id = l.item WHERE l.status = 'open'");
  for (const r of open.rows) {
    assert.equal(r.lock, `L:${r.id}`);
    assert.equal(Number(r.owner), Number(r.seller));
  }
}

test('TOTP matches RFC 6238 test vectors', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(hotp(secret, 1), '287082'); // T=59s
  assert.equal(totp(secret, 1111111109 * 1000), '081804');
  assert.equal(verifyTotp(secret, totp(secret)) >= 0, true);
  assert.equal(verifyTotp(secret, '000000', 0) >= 0 && totp(secret, 0) !== '000000', false);
});

for (const url of urls) {
  const kind = url.split(':')[0];

  test(`[${kind}] accounts: register, login, sessions, recovery, throttling`, async () => {
    const store = url.startsWith('postgres') ? await freshPg(url) : await openStore(url);
    const acc = new Accounts(store);
    const reg = await acc.register({ name: '阿星', password: 'correct horse' });
    assert.equal(reg.account.name, '阿星');
    assert.equal(reg.recoveryCodes.length, 8);
    await assert.rejects(acc.register({ name: '阿星', password: 'whatever12' }), { code: 'NAME_TAKEN' });
    await assert.rejects(acc.register({ name: 'x', password: 'whatever12' }), { code: 'BAD_NAME' });
    assert.equal((await acc.resume(reg.token)).id, reg.account.id);
    await assert.rejects(acc.login({ name: '阿星', password: 'wrong', ip: '1' }), { code: 'BAD_LOGIN' });
    const lg = await acc.login({ name: '阿星', password: 'correct horse', ip: '1' });
    assert.ok(lg.token);
    // Session tokens are stored hashed.
    const raw = await store.query('SELECT token_hash FROM sessions');
    assert.ok(raw.rows.every((r) => !r.token_hash.startsWith('S')));
    // Recovery code resets the password and revokes old sessions.
    const rec = await acc.recover({ name: '阿星', code: reg.recoveryCodes[0], newPassword: 'new password!' });
    assert.equal(await acc.resume(reg.token), null);
    assert.ok(await acc.resume(rec.token));
    await assert.rejects(acc.recover({ name: '阿星', code: reg.recoveryCodes[0], newPassword: 'again again' }), { code: 'BAD_RECOVERY' });
    // Throttle after 10 failures.
    for (let i = 0; i < 10; i++) await acc.login({ name: 'nobody', password: 'x', ip: '9' }).catch(() => {});
    await assert.rejects(acc.login({ name: '阿星', password: 'new password!', ip: '9' }), { code: 'THROTTLED' });
    // TOTP
    const id = reg.account.id;
    const { secret } = await acc.totpSetup(id);
    await acc.totpEnable(id, totp(secret));
    await assert.rejects(acc.login({ name: '阿星', password: 'new password!', ip: '2' }), { code: 'TOTP_REQUIRED' });
    await assert.rejects(acc.login({ name: '阿星', password: 'new password!', ip: '2', totp: totp(secret) }), { code: 'BAD_TOTP' }, 'replayed code accepted');
    await store.close();
  });

  test(`[${kind}] security state is shared by replicas: TOTP replay, login throttle, registrations per IP`, async () => {
    const store = url.startsWith('postgres') ? await freshPg(url) : await openStore(url);
    // Two Accounts objects on one database = two meta replicas.
    const r1 = new Accounts(store, { registerPerHour: 3, pepper: 'p' });
    const r2 = new Accounts(store, { registerPerHour: 3, pepper: 'p' });
    const reg = await r1.register({ name: 'shared', password: 'password123', ip: '10.0.0.1' });
    const id = reg.account.id;
    const { secret } = await r1.totpSetup(id);
    const code = totp(secret);
    await r1.totpEnable(id, code);
    // The same code used on the other replica is a replay.
    await assert.rejects(r2.login({ name: 'shared', password: 'password123', totp: code, ip: '1' }), { code: 'BAD_TOTP' });
    // An active 2FA secret cannot be replaced without a code (stolen session).
    await assert.rejects(r2.totpSetup(id), { code: 'TOTP_ENABLED' });
    // Failures from one IP, spread over both replicas, lock that IP...
    for (let i = 0; i < 10; i++) await (i % 2 ? r1 : r2).login({ name: 'shared', password: 'wrong', ip: 'attacker' }).catch(() => {});
    await assert.rejects(r2.login({ name: 'shared', password: 'password123', ip: 'attacker' }), { code: 'THROTTLED' });
    // ...but not the owner: nobody can lock a player out of their account.
    await assert.rejects(r1.login({ name: 'shared', password: 'password123', ip: 'owner' }), { code: 'TOTP_REQUIRED' });
    // A botnet hammering one name gets one guess per address once the name is hot.
    for (let i = 0; i < 100; i++) await r1.login({ name: 'shared', password: 'wrong', ip: `bot${i}` }).catch(() => {});
    await assert.rejects(r2.login({ name: 'shared', password: 'password123', ip: 'bot5' }), { code: 'THROTTLED' });
    await assert.rejects(r2.login({ name: 'shared', password: 'password123', ip: 'owner' }), { code: 'TOTP_REQUIRED' });
    // Registrations from one IP are counted across replicas.
    await r2.register({ name: 'shared2', password: 'password123', ip: '10.0.0.1' });
    await r1.register({ name: 'shared3', password: 'password123', ip: '10.0.0.1' });
    await assert.rejects(r2.register({ name: 'shared4', password: 'password123', ip: '10.0.0.1' }), { code: 'RATE' });
    await r2.register({ name: 'shared5', password: 'password123', ip: '10.0.0.2' });
    // IPs are stored only as keyed hashes.
    const raw = await store.query("SELECT reg_ip FROM accounts WHERE name_lc = 'shared'");
    assert.ok(raw.rows[0].reg_ip && !raw.rows[0].reg_ip.includes('10.0.0.1'));
    // Abuse signals: three fresh alts on one IP funnel their coins to a main.
    const eco = new Economy(store);
    const main = (await r1.register({ name: 'mainacct', password: 'password123', ip: '10.9.9.9' })).account.id;
    for (let i = 0; i < 3; i++) {
      const alt = (await r2.register({ name: `alt${i}`, password: 'password123', ip: '10.0.0.7' })).account.id;
      await store.tx((t) => move(t, { key: `funnel:${i}`, kind: 'trade', from: alt, to: main, amount: 90 }));
    }
    const f = await eco.flows({ hours: 1 });
    const top = f.receivers[0];
    assert.equal(top.id, main);
    assert.equal(top.received, 270);
    assert.equal(top.senders, 3);
    assert.equal(top.suspicious, true);
    assert.ok(f.clusters.some((c) => c.accounts >= 3 && c.names.includes('alt0')));
    const v = await store.query('SELECT max(v) AS v FROM schema_version');
    assert.equal(Number(v.rows[0].v), SCHEMA_VERSION);
    await store.close();
  });

  test(`[${kind}] economy invariants hold under concurrent market, trade and transfer storms`, async () => {
    const store = url.startsWith('postgres') ? await freshPg(url) : await openStore(url);
    const acc = new Accounts(store);
    const eco = new Economy(store);
    const N = 12;
    const ids = [];
    for (let i = 0; i < N; i++) ids.push((await acc.register({ name: `p${i}_${kind}`, password: 'password123' })).account.id);
    for (const id of ids) assert.equal(await eco.balance(id), STARTER_GRANT);
    // Each player captures 4 specimens.
    const items = new Map();
    for (const id of ids) {
      items.set(id, []);
      for (let k = 0; k < 4; k++) items.get(id).push((await eco.captured(id, `cap:test:${id}:${k}`, { genome: 'x', hue: 0.5 })).item);
    }
    // Capturing the same organism twice yields the same item, not a new one.
    const again = await eco.captured(ids[0], `cap:test:${ids[0]}:0`, { genome: 'x' });
    assert.equal(again.created, false);

    // Everyone lists 2 items.
    const listings = [];
    for (const id of ids) for (const it of items.get(id).slice(0, 2)) listings.push((await eco.list(id, it, 5 + Math.floor(Math.random() * 30))).listing);

    // Storm: concurrent buys (several buyers race for each listing), trades,
    // cancels, direct transfers, rewards replayed with the same key.
    const rnd = (a) => a[Math.floor(Math.random() * a.length)];
    const ops = [];
    for (const l of listings) for (let k = 0; k < 3; k++) ops.push(() => eco.buy(rnd(ids), l));
    for (let k = 0; k < 40; k++) {
      ops.push(async () => {
        const a = rnd(ids);
        const b = rnd(ids.filter((x) => x !== a));
        const tr = await eco.openTrade(a, b, async () => false);
        const s1 = await eco.setOffer(a, tr.id, { items: items.get(a).slice(2, 3), coins: Math.floor(Math.random() * 20) });
        const s2 = await eco.setOffer(b, tr.id, { items: items.get(b).slice(3, 4), coins: Math.floor(Math.random() * 20) });
        await eco.confirm(a, tr.id, s2.version);
        await eco.confirm(b, tr.id, s2.version);
        void s1;
      });
    }
    for (let k = 0; k < 60; k++) {
      ops.push(() => store.tx((t) => move(t, { key: `gift:${k}`, kind: 'gift', from: rnd(ids), to: rnd(ids), amount: 1 + Math.floor(Math.random() * 40) })));
      ops.push(() => store.tx((t) => mint(t, rnd(ids), 3, `reward:${k % 10}`, 'reward'))); // keys repeat: must apply once
    }
    for (const l of listings.slice(0, 6)) ops.push(() => eco.cancelListing(rnd(ids), l));
    ops.sort(() => Math.random() - 0.5);
    const results = await Promise.allSettled(ops.map((f) => f()));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    assert.ok(ok > 50, `too few operations succeeded (${ok})`);
    for (const r of results) {
      if (r.status === 'rejected' && !r.reason.code) throw r.reason; // only expected business errors
    }

    // Each listing sold at most once; each sale paid the fee.
    const sales = await store.query("SELECT id, price FROM listings WHERE status = 'sold'");
    for (const s of sales.rows) {
      const fee = await store.query('SELECT amount FROM ledger WHERE key = $1', [`buy:${s.id}:fee`]);
      assert.equal(Number(fee.rows[0].amount), Math.max(1, Math.ceil(Number(s.price) * MARKET_FEE)));
    }
    // The daily capture quota holds under parallel requests.
    const hoarder = ids[1];
    const already = (await store.query("SELECT count(*) AS n FROM item_log WHERE to_acct = $1 AND action = 'create'", [hoarder])).rows[0].n;
    const burst = await Promise.allSettled(Array.from({ length: 60 }, (_, k) => eco.captured(hoarder, `cap:burst:${k}`, { g: 1 })));
    assert.equal(burst.filter((x) => x.status === 'fulfilled').length, CAPTURES_PER_DAY - Number(already));
    assert.ok(burst.filter((x) => x.status === 'rejected').every((x) => x.reason.code === 'LIMIT'));
    // A lineage spread over many shards earns at most the cap per period.
    const rich = ids[0];
    const b0 = await eco.balance(rich);
    await Promise.all(Array.from({ length: 16 }, (_, sh) => eco.reward([[rich, 3]], `life:w:7:${sh}`, { period: 'life:w:7', cap: 3 })));
    assert.equal((await eco.balance(rich)) - b0, 3, 'cap is per account per period, across shards');
    await eco.reward([[rich, 3]], 'life:w:8:0', { period: 'life:w:8', cap: 3 });
    assert.equal((await eco.balance(rich)) - b0, 6, 'next period pays again');
    // Reward keys applied exactly once each.
    const rw = await store.query("SELECT count(*) AS n FROM ledger WHERE key LIKE 'reward:%'");
    assert.equal(Number(rw.rows[0].n), 10);
    await invariants(store);

    // Release: consumes item + fee once.
    const someone = ids.find(async () => true);
    const mine = await eco.items(someone);
    const free = mine.find((x) => !x.lock);
    if (free && (await eco.balance(someone)) >= RELEASE_FEE) {
      const r = await eco.release(someone, free.id);
      assert.equal(r.spawnKey, `rel:${free.id}`);
      await assert.rejects(eco.release(someone, free.id), { code: 'ITEM_UNAVAILABLE' });
    }
    await invariants(store);
    const st = await eco.stats();
    assert.equal(st.balanceSum, 0);
    await store.close();
  });
}

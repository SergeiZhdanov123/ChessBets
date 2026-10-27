import { boot, Client, sleep, checkBooks } from './helpers.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// The helpers switch the bonus off; this file turns it on before the app loads.
process.env.SIGNUP_BONUS = '100';
process.env.SIGNUP_BONUS_MIN_DEPOSIT = '5000';

let app;
before(async () => { app = await boot(); });
after(async () => { await app.close(); });
const db = () => app.ctx.db;

async function balanceSettles(c, want) {
  for (let i = 0; i < 100; i++) {
    if ((await c.balance()) === want) return;
    await sleep(20);
  }
  assert.equal(await c.balance(), want);
}

test('sign-up bonus: $1 once deposits reach $50, paid once, by the house', async () => {
  const cfg = await new Client(app.base).req('/api/config');
  assert.deepEqual(cfg.data.signupBonus, { amount: 100, minDeposit: 5000 });

  const c = new Client(app.base);
  const u = await c.register('bonususer');
  assert.equal(u.bonus, 'pending');

  await c.fund(3000);
  await sleep(100);
  assert.equal(await c.balance(), 3000, 'no bonus below the minimum');

  await c.fund(2000); // two deposits that add up to $50 count
  await balanceSettles(c, 5100);
  assert.equal((await c.req('/api/me')).data.user.bonus, 'paid');
  const rows = await db().ledger.find({ kind: 'bonus' });
  assert.deepEqual(rows.map((r) => [r.user_id, r.amount]).sort(), [[c.user.id, 100], [null, -100]].sort());

  await c.fund(5000);
  await sleep(100);
  assert.equal(await c.balance(), 10_100, 'only one bonus per account');
  assert.equal(await db().ledger.count({ kind: 'bonus' }), 2);

  const w = await c.req('/api/wallet');
  assert.ok(w.data.ledger.some((r) => r.kind === 'bonus' && r.amount === 100 && r.note === 'Sign-up bonus'));
  await checkBooks(db());
});

test('sign-up bonus: accounts made before the offer, and suspended ones, get nothing', async () => {
  const old = new Client(app.base);
  await old.register('olduser');
  await db().users.update({ _id: old.user.id }, { $set: { bonus: null } }); // signed up before the offer
  await old.fund(6000);
  await sleep(100);
  assert.equal(await old.balance(), 6000);

  const s = new Client(app.base);
  await s.register('suspuser');
  await s.fund(4000);
  await db().users.update({ _id: s.user.id }, { $set: { status: 'suspended' } });
  await s.req('/api/wallet/deposit', { coin: 'USDT', amount: 2000 }).catch(() => {});
  await sleep(150);
  const row = await db().users.findOne({ _id: s.user.id }, { projection: { bonus: 1 } });
  assert.equal(row.bonus, 'pending');
  assert.equal(await db().ledger.count({ kind: 'bonus', user_id: s.user.id }), 0);
});

test('admin player list: every account with deposits, withdrawals and bonus state; staff only', async () => {
  const a = new Client(app.base);
  await a.register('listadmin');
  assert.notEqual((await a.req('/api/admin/users')).status, 200, 'players cannot see it');
  await db().users.update({ _id: a.user.id }, { $set: { is_admin: 1 } });
  const r = await a.req('/api/admin/users');
  assert.equal(r.status, 200);
  const names = r.data.users.map((u) => u.username);
  for (const n of ['bonususer', 'olduser', 'suspuser', 'listadmin']) assert.ok(names.includes(n), n);
  const b = r.data.users.find((u) => u.username === 'bonususer');
  assert.equal(b.deposited, 10_000);
  assert.equal(b.withdrawn, 0);
  assert.equal(b.bonus, 'paid');
  assert.equal(b.balance, 10_100);
  assert.equal(r.data.users.find((u) => u.username === 'listadmin').isAdmin, true);
  const f = await a.req('/api/admin/users?q=bonus');
  assert.deepEqual(f.data.users.map((u) => u.username), ['bonususer']);
});

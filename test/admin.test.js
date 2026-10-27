import { boot, Client } from './helpers.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

let app;
before(async () => { app = await boot(); });
after(async () => { await app.close(); });
const db = () => app.ctx.db;

test('admin player list: every account with deposits and withdrawals; staff only', async () => {
  const p = new Client(app.base);
  await p.register('listplayer');
  await p.fund(3000);
  await p.fund(2000);
  await new Client(app.base).register('quietone');

  const a = new Client(app.base);
  await a.register('listadmin');
  assert.notEqual((await a.req('/api/admin/users')).status, 200, 'players cannot see it');
  await db().users.update({ _id: a.user.id }, { $set: { is_admin: 1 } });
  const r = await a.req('/api/admin/users');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.users.map((u) => u.username), ['listadmin', 'quietone', 'listplayer'], 'newest first');
  const u = r.data.users.find((x) => x.username === 'listplayer');
  assert.equal(u.deposited, 5000);
  assert.equal(u.withdrawn, 0);
  assert.equal(u.balance, 5000);
  assert.equal(r.data.users.find((x) => x.username === 'listadmin').isAdmin, true);
  const f = await a.req('/api/admin/users?q=list');
  assert.deepEqual(f.data.users.map((x) => x.username), ['listadmin', 'listplayer']);
});

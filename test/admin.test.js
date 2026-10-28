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

test('analytics: events are recorded, admins are not, and the funnel adds up', async () => {
  const s = Date.now().toString(36);
  const ev = (k, p, l, extra = {}) => ({ k, p, l, s, t: Date.now(), m: false, ...extra });

  // A visitor who looks around and leaves.
  const v = new Client(app.base);
  await v.req('/api/config');
  assert.equal((await v.req('/api/t', { e: [ev('view', '/', null, { r: 'reddit.com', s: 'aaaaaa1' }), ev('click', '/', 'Fair Play', { s: 'aaaaaa1' })] })).status, 204);

  // A visitor who signs up and deposits.
  const p = new Client(app.base);
  await p.req('/api/config');
  await p.req('/api/t', { e: [ev('view', '/', null, { r: 'google.com', s: 'bbbbbb1' }), ev('auth_open', '/', 'register', { s: 'bbbbbb1' })] });
  await p.register('funnelguy');
  await p.req('/api/t', { e: [ev('wallet_open', '/', 'deposit', { s: 'bbbbbb1' }), ev('view', '/play', null, { s: 'bbbbbb1' })] });
  await p.fund(2500);

  // Junk is dropped: unknown kinds, bad paths, typed-looking fields.
  await p.req('/api/t', { e: [{ k: 'keystroke', p: '/', s: 'x' }, ev('view', 'javascript:alert(1)', null, { s: 'bbbbbb1' })] });

  const a = new Client(app.base);
  await a.register('statsadmin');
  await db().users.update({ _id: a.user.id }, { $set: { is_admin: 1 } });
  await a.req('/api/t', { e: [ev('view', '/', null, { s: 'cccccc1' })] });
  await new Promise((r) => setTimeout(r, 200));

  const kinds = (await db().events.find({})).map((e) => e.kind);
  assert.ok(!kinds.includes('keystroke'));
  assert.equal((await db().events.find({ path: 'javascript:alert(1)' })).length, 0);
  assert.equal((await db().events.count({ session: 'cccccc1' })), 0, 'admins are not recorded');

  assert.notEqual((await p.req('/api/admin/analytics')).status, 200, 'players cannot see it');
  const r = await a.req('/api/admin/analytics?days=7');
  assert.equal(r.status, 200);
  const f = Object.fromEntries(r.data.funnel.map((x) => [x.key, x.n]));
  assert.ok(f.visited >= 2);
  assert.equal(f.signup_open, 1);
  assert.ok(f.signed_up >= 1);
  const me = r.data.players.find((x) => x.username === 'funnelguy');
  assert.equal(me.stage, 'deposited');
  assert.equal(me.deposited, 2500);
  assert.equal(me.source, 'google.com');
  assert.ok(!r.data.players.some((x) => x.username === 'statsadmin'), 'admins are left out');
  assert.ok(r.data.sources.some((x) => x.source === 'reddit.com' && x.visitors === 1 && x.signups === 0));
  assert.ok(r.data.clicks.some((c) => c.label === 'Fair Play' && c.path === '/'));
  assert.equal(r.data.daily.length, 7);
  assert.ok(r.data.visits.count >= 2);
  const left = r.data.pages.find((x) => x.key === '/play');
  assert.equal(left.exits, 1);
});

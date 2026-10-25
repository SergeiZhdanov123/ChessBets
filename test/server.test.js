import { boot, Client, sleep, checkBooks } from './helpers.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.FIRST_MOVE_MS = '600';
process.env.ABANDON_MS_3 = '500';

let app;
before(async () => { app = await boot(); });
after(async () => { await app.close(); });

const db = () => app.ctx.db;
let n = 0;
async function player(fund = 10_000) {
  const c = new Client(app.base);
  await c.register(`p${++n}_${Math.random().toString(36).slice(2, 6)}`);
  if (fund) await c.fund(fund);
  await c.connect();
  return c;
}

// Join both to a queue and return { white, black, id }.
async function match(a, b, tc = 3, stake = 100) {
  a.send({ t: 'queue-join', tc, stake });
  await a.wait((m) => m.t === 'queue' && m.state === 'joined');
  b.send({ t: 'queue-join', tc, stake });
  const ma = await a.wait((m) => m.t === 'matched');
  await b.wait((m) => m.t === 'matched');
  a.send({ t: 'sub', id: ma.id });
  b.send({ t: 'sub', id: ma.id });
  const ga = await a.wait((m) => m.t === 'game' && m.game.id === ma.id);
  await b.wait((m) => m.t === 'game' && m.game.id === ma.id);
  return ga.game.you === 'w' ? { white: a, black: b, id: ma.id } : { white: b, black: a, id: ma.id };
}

async function play(g, sans) {
  const { Chess } = await import('chess.js');
  const c = new Chess();
  for (const san of sans) {
    const mover = c.turn() === 'w' ? g.white : g.black;
    const mv = c.move(san);
    mover.send({ t: 'move', id: g.id, u: mv.from + mv.to + (mv.promotion || ''), ply: c.history().length - 1 });
    await g.white.wait((m) => m.t === 'move' && m.id === g.id && m.ply === c.history().length);
  }
}

test('registration rules, CSRF header, sessions', async () => {
  const c = new Client(app.base);
  await c.req('/api/config');
  assert.equal((await c.req('/api/register', { username: 'x', password: 'password123', adult: true, terms: true })).status, 400);
  assert.equal((await c.req('/api/register', { username: 'okname', password: 'short', adult: true, terms: true })).status, 400);
  assert.equal((await c.req('/api/register', { username: 'okname', password: 'password123', adult: false, terms: true })).status, 400);
  assert.equal((await c.req('/api/register', { username: 'okname', password: 'password123', adult: true, terms: true }, { headers: { 'x-cb': '0' } })).status, 403);
  assert.equal((await c.req('/api/register', { username: 'okname', password: 'password123', adult: true, terms: true })).status, 200);
  assert.equal((await c.req('/api/register', { username: 'OKNAME', password: 'password123', adult: true, terms: true })).status, 409);
  assert.equal((await c.req('/api/me')).data.user.username, 'okname');
  await c.req('/api/logout', {});
  assert.equal((await c.req('/api/me')).data.user, null);
  assert.equal((await c.req('/api/login', { username: 'okname', password: 'wrong-password' })).status, 401);
  assert.equal((await c.req('/api/login', { username: 'okname', password: 'password123' })).status, 200);
  const evil = await c.req('/api/wallet/deposit', { coin: 'BTC', amount: 100 }, { headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
});

test('deposits confirm and credit; withdrawals take 5% and validate addresses', async () => {
  const c = new Client(app.base);
  await c.register('walletuser');
  const addr = await c.req('/api/wallet/address', { coin: 'BTC' });
  assert.match(addr.data.address, /^demo-btc-/);
  assert.match(addr.data.qr, /<svg/);
  assert.equal(await c.fund(5000, 'BTC'), 5000);
  assert.equal((await c.req('/api/wallet/withdraw', { coin: 'ETH', address: 'nope', amount: 1000 })).status, 400);
  assert.equal((await c.req('/api/wallet/withdraw', { coin: 'ETH', address: '0x' + 'b'.repeat(40), amount: 400 })).status, 400);
  assert.equal((await c.req('/api/wallet/withdraw', { coin: 'ETH', address: '0x' + 'b'.repeat(40), amount: 999_999 })).status, 400);
  const w = await c.req('/api/wallet/withdraw', { coin: 'ETH', address: '0x' + 'b'.repeat(40), amount: 2000 });
  assert.equal(w.status, 200);
  assert.equal(w.data.withdrawal.fee, 100);
  assert.equal(w.data.withdrawal.net, 1900);
  assert.equal(await c.balance(), 3000);
  await sleep(120);
  const after1 = await c.req('/api/wallet');
  assert.equal(after1.data.withdrawals[0].status, 'completed');
  assert.ok(await db().ledger.findOne({ user_id: null, kind: 'withdraw_fee', amount: 100 }));
  await checkBooks(db());
});

test('queue: insufficient funds rejected, leaving returns the stake', async () => {
  const poor = await player(400);
  poor.send({ t: 'queue-join', tc: 3, stake: 500 });
  const e = await poor.wait((m) => m.t === 'error');
  assert.match(e.message, /Insufficient/);
  const a = await player(1000);
  a.send({ t: 'queue-join', tc: 10, stake: 1000 });
  await a.wait((m) => m.t === 'queue' && m.state === 'joined');
  assert.equal(await a.balance(), 0);
  a.send({ t: 'queue-leave' });
  await a.wait((m) => m.t === 'queue' && m.state === 'left');
  assert.equal(await a.balance(), 1000);
  poor.close(); a.close();
  await checkBooks(db());
});

test('human game: checkmate pays the pot minus 3% rake', async () => {
  const a = await player(), b = await player();
  const g = await match(a, b, 3, 500);
  await play(g, ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']);
  const end = await g.white.wait((m) => m.t === 'end');
  assert.equal(end.game.result, '1-0');
  assert.equal(end.game.reason, 'checkmate');
  assert.equal(end.game.you, 'w');
  assert.equal(await g.white.balance(), 10_000 - 500 + 970);
  assert.equal(await g.black.balance(), 10_000 - 500);
  assert.equal((await db().games.findOne({ _id: g.id })).rake, 30);
  await checkBooks(db());
  a.close(); b.close();
});

test('human game: draw by agreement still takes the rake from each side', async () => {
  const a = await player(), b = await player();
  const g = await match(a, b, 10, 1000);
  await play(g, ['d4', 'd5']);
  g.white.send({ t: 'draw-offer', id: g.id });
  await g.black.wait((m) => m.t === 'draw' && m.offer === 'w');
  g.black.send({ t: 'draw-accept', id: g.id });
  const end = await g.black.wait((m) => m.t === 'end');
  assert.equal(end.game.reason, 'agreement');
  assert.equal(await a.balance(), 10_000 - 30);
  assert.equal(await b.balance(), 10_000 - 30);
  await checkBooks(db());
  a.close(); b.close();
});

test('no first move: game aborts and both stakes come back in full', async () => {
  const a = await player(), b = await player();
  await match(a, b, 3, 100);
  const end = await a.wait((m) => m.t === 'end', 4000);
  assert.equal(end.game.status, 'aborted');
  assert.equal(await a.balance(), 10_000);
  assert.equal(await b.balance(), 10_000);
  await checkBooks(db());
  a.close(); b.close();
});

test('illegal, out-of-turn and stale moves are rejected by the server', async () => {
  const a = await player(), b = await player();
  const g = await match(a, b, 3, 100);
  g.black.send({ t: 'move', id: g.id, u: 'e7e5', ply: 0 });
  assert.match((await g.black.wait((m) => m.t === 'reject')).message, /Not your turn/);
  g.white.send({ t: 'move', id: g.id, u: 'e2e5', ply: 0 });
  assert.match((await g.white.wait((m) => m.t === 'reject')).message, /Illegal/);
  g.white.send({ t: 'move', id: g.id, u: 'e2e4', ply: 3 });
  assert.match((await g.white.wait((m) => m.t === 'reject')).message, /Out of sync/);
  g.white.send({ t: 'resign', id: g.id }); // fewer than 2 plies: abort
  await g.white.wait((m) => m.t === 'end');
  a.close(); b.close();
});

test('running out of time loses; the clock is server side', async () => {
  const a = await player(), b = await player();
  const g = await match(a, b, 3, 100);
  await play(g, ['e4', 'e5']);
  const live = app.ctx.games.get(g.id);
  live.clocks.w = 80;
  live.turnStartedAt = Date.now();
  live.armFlag();
  const end = await g.black.wait((m) => m.t === 'end', 3000);
  assert.equal(end.game.reason, 'timeout');
  assert.equal(end.game.result, '0-1');
  a.close(); b.close();
});

test('timeout against a lone king is a draw', async () => {
  const a = await player(), b = await player();
  const g = await match(a, b, 3, 100);
  await play(g, ['e4', 'e5']);
  const live = app.ctx.games.get(g.id);
  live.chess.load('4k3/8/8/8/8/8/8/R3K3 b - - 0 1'); // black to move, black has only a king
  live.clocks.b = 50;
  live.turnStartedAt = Date.now();
  live.armFlag();
  const end = await g.white.wait((m) => m.t === 'end', 3000);
  assert.equal(end.game.reason, 'timeout');
  assert.equal(end.game.result, '1-0'); // white still has a rook, so black loses
  a.close(); b.close();
});

test('abandoning a game loses it after the grace period', async () => {
  const a = await player(), b = await player();
  const g = await match(a, b, 3, 100);
  await play(g, ['e4', 'e5']);
  g.black.close();
  const p = await g.white.wait((m) => m.t === 'presence');
  assert.ok(p.gone.b);
  const end = await g.white.wait((m) => m.t === 'end', 3000);
  assert.equal(end.game.reason, 'abandoned');
  assert.equal(end.game.result, '1-0');
  a.close(); b.close();
});

test('live games are private to the players', async () => {
  const a = await player(), b = await player(), c = await player(0);
  const g = await match(a, b, 3, 100);
  c.send({ t: 'sub', id: g.id });
  assert.equal((await c.wait((m) => m.t === 'error')).code, 'private');
  assert.equal((await c.req(`/api/games/${g.id}`)).status, 403);
  g.white.send({ t: 'resign', id: g.id });
  await g.white.wait((m) => m.t === 'end');
  assert.equal((await c.req(`/api/games/${g.id}`)).status, 200);
  a.close(); b.close(); c.close();
});

test('two accounts from the same browser are never paired', async () => {
  const a = new Client(app.base);
  await a.register(`dev_a${n++}`);
  await a.fund(1000);
  const b = new Client(app.base);
  b.cookies.cbd = a.cookies.cbd; // same device id
  await b.register(`dev_b${n++}`);
  await b.fund(1000);
  await a.connect(); await b.connect();
  a.send({ t: 'queue-join', tc: 10, stake: 100 });
  b.send({ t: 'queue-join', tc: 10, stake: 100 });
  await sleep(400);
  assert.equal(app.ctx.matchmaker.counts()['10:100'], 2);
  assert.match((await a.wait((m) => m.t === 'queue-note')).note, /same browser/);
  assert.ok(await db().fair_play_events.findOne({ kind: 'multi_account', user_id: b.user.id }));
  const c = await player();
  c.send({ t: 'queue-join', tc: 10, stake: 100 });
  const m = await c.wait((x) => x.t === 'matched');
  assert.ok(m.id);
  a.send({ t: 'queue-leave' }); b.send({ t: 'queue-leave' });
  const live = app.ctx.games.get(m.id);
  await live.end({ status: 'aborted', reason: 'aborted' });
  a.close(); b.close(); c.close();
  await checkBooks(db());
});

test('several people waiting are all paired, including shared networks and past shared browsers', async () => {
  // Four players in one queue: everyone must get a game.
  const ps = [];
  for (let i = 0; i < 4; i++) ps.push(await player(2000));
  // Two of them once signed in on the same browser, then moved to their own.
  for (const p of ps.slice(0, 2)) {
    await db().user_devices.insert({ user_id: p.user.id, device_id: 'f'.repeat(32), ip: '127.0.0.1', first_seen: Date.now(), last_seen: Date.now() });
  }
  for (const p of ps) p.send({ t: 'queue-join', tc: 3, stake: 500 });
  const ids = await Promise.all(ps.map((p) => p.wait((m) => m.t === 'matched', 4000).then((m) => m.id)));
  assert.equal(new Set(ids).size, 2, 'four players should make two games');
  assert.equal(app.ctx.matchmaker.counts()['3:500'], 0);
  for (const id of new Set(ids)) await app.ctx.games.get(id).end({ status: 'aborted', reason: 'aborted' });
  // Just the two who once shared a browser (now on their own): still paired.
  ps[0].send({ t: 'queue-join', tc: 10, stake: 500 });
  ps[1].send({ t: 'queue-join', tc: 10, stake: 500 });
  const m = await ps[0].wait((x) => x.t === 'matched', 4000);
  const live = app.ctx.games.get(m.id);
  assert.deepEqual([live.white.userId, live.black.userId].sort(), [ps[0].user.id, ps[1].user.id].sort());
  await live.end({ status: 'aborted', reason: 'aborted' });
  ps.forEach((p) => p.close());
  await checkBooks(db());
});

test('the same two players can keep playing each other', async () => {
  const a = await player(), b = await player();
  for (let i = 0; i < 4; i++) {
    const g = await match(a, b, 3, 100);
    await play(g, ['e4', 'e5']);
    g.white.send({ t: 'resign', id: g.id });
    await a.wait((m) => m.t === 'end' && m.id === g.id);
    await b.wait((m) => m.t === 'end' && m.id === g.id);
  }
  assert.equal(await db().games.count({ status: 'finished', $or: [{ white_id: a.user.id }, { black_id: a.user.id }] }), 4);
  a.close(); b.close();
  await checkBooks(db());
});

test('with a choice, the matchmaker avoids a repeat opponent', async () => {
  const a = await player(), b = await player();
  const g = await match(a, b, 10, 500);
  await play(g, ['e4', 'e5']);
  g.white.send({ t: 'resign', id: g.id });
  await a.wait((m) => m.t === 'end'); await b.wait((m) => m.t === 'end');
  const row = (p) => db().users.findOne({ _id: p.user.id });
  // Pair by hand with the timer off, so it can't pair two of them early.
  app.ctx.matchmaker.stop();
  try {
    for (let trial = 0; trial < 8; trial++) {
      const c = await player(2000);
      const before = new Set(app.ctx.games.live.keys());
      for (const p of [a, b, c]) await app.ctx.matchmaker.join(await row(p), 10, 1000, {});
      await app.ctx.matchmaker.tick();
      const fresh = [...app.ctx.games.live.values()].filter((x) => !before.has(x.id));
      assert.equal(fresh.length, 1);
      const seats = [fresh[0].white.userId, fresh[0].black.userId];
      assert.ok(seats.includes(c.user.id), `trial ${trial}: paired the two players who just met`);
      await fresh[0].end({ status: 'aborted', reason: 'aborted' });
      for (const p of [a, b]) await app.ctx.matchmaker.leave(p.user.id);
      await db().games.delete({ _id: fresh[0].id }); // keep c's history out of later trials
      c.close();
    }
  } finally {
    app.ctx.matchmaker.start();
  }
  a.close(); b.close();
  await checkBooks(db());
});

test('chat: typed messages reach only the opponent, cleaned and rate limited', async () => {
  const a = await player(), b = await player(), c = await player(0);
  const g = await match(a, b, 10, 100);
  c.send({ t: 'sub', id: g.id });
  await c.wait((m) => m.t === 'error');
  g.white.send({ t: 'chat', id: g.id, text: '  hello\u0000   there  ' });
  const got = await g.black.wait((m) => m.t === 'chat' && m.entry.c === 'w');
  assert.equal(got.entry.text, 'hello there');
  assert.equal(got.entry.c, 'w');
  await g.white.wait((m) => m.t === 'chat' && m.entry.c === 'w'); // sender sees their own message
  g.black.send({ t: 'chat', id: g.id, k: 0 });
  assert.equal((await g.white.wait((m) => m.t === 'chat' && m.entry.c === 'b')).entry.text, 'Good luck');
  g.white.send({ t: 'chat', id: g.id, text: 'x'.repeat(300) });
  assert.equal((await g.black.wait((m) => m.t === 'chat' && m.entry.c === 'w' && m.entry.text.startsWith('xxx'))).entry.text.length, 200);
  g.white.send({ t: 'chat', id: g.id, text: 'one' });
  g.white.send({ t: 'chat', id: g.id, text: 'two' });
  assert.match((await g.white.wait((m) => m.t === 'error' && m.code === 'chat')).message, /Slow down/);
  await sleep(100);
  assert.ok(!c.msgs.some((m) => m.t === 'chat'), 'outsiders must not receive chat');
  const snapB = app.ctx.games.get(g.id).snapshot(b.user.id);
  const snapC = app.ctx.games.get(g.id).snapshot(c.user.id);
  assert.ok(snapB.chat.length >= 3);
  assert.equal(snapC.chat.length, 0);
  g.white.send({ t: 'resign', id: g.id });
  await a.wait((m) => m.t === 'end' && m.id === g.id);
  a.close(); b.close(); c.close();
});

test('unique visitors: one per browser per day, admins not counted', async () => {
  const day = new Date().toISOString().slice(0, 10);
  const before = await db().visits.count({ day });
  const v = new Client(app.base);
  await v.req('/api/config');
  await v.req('/api/config');
  await sleep(100);
  assert.equal(await db().visits.count({ day }), before + 1);
  const admin = await player(0);
  await db().users.update({ _id: admin.user.id }, { $set: { is_admin: 1 } });
  await admin.req('/api/config');
  await sleep(100);
  assert.equal(await db().visits.count({ day }), before + 2); // counted once as a guest, before the flag
  const o = (await admin.req('/api/admin/overview')).data;
  assert.equal(o.visitors.today, before + 2);
  admin.close();
});

test('lobby stats: numbers below their minimum are withheld', async () => {
  const c = await player(0);
  const { config } = await import('../src/config.js');
  const saved = { ...config.statsMin };
  try {
    Object.assign(config.statsMin, { online: 1_000_000, playing: 1_000_000, games24h: 1_000_000, wagered24h: 1_000_000_000 });
    assert.deepEqual((await c.req('/api/stats')).data, { online: null, playing: null, games24h: null, wagered24h: null });
    Object.assign(config.statsMin, { online: 1, playing: 0, games24h: 0, wagered24h: 0 });
    const s = (await c.req('/api/stats')).data;
    assert.ok(s.online >= 1);
    for (const k of ['playing', 'games24h', 'wagered24h']) assert.equal(typeof s[k], 'number', k);
  } finally { Object.assign(config.statsMin, saved); }
  c.close();
});

test('scheduled suspension: withdrawals held under review, then the balance is forfeited', async () => {
  const a = await player(5000);
  await app.ctx.enforcement.review(a.user.id, 'test');
  await app.ctx.enforcement.schedule('suspend', a.user.id, 50, { reason: 'Fair play' });
  const u = await db().users.findOne({ _id: a.user.id });
  assert.equal(u.review, 1);
  assert.equal(u.status, 'active');
  const pending = await db().scheduled_actions.findOne({ user_id: a.user.id, status: 'pending' });
  assert.ok(pending && pending.kind === 'suspend');

  // Withdrawal goes into review instead of out.
  const w = await a.req('/api/wallet/withdraw', { coin: 'USDT', address: '0x' + 'c'.repeat(40), amount: 1000 });
  assert.equal(w.data.withdrawal.status, 'review');

  await sleep(120);
  await app.ctx.enforcement.tick();
  const s = await db().users.findOne({ _id: a.user.id });
  assert.equal(s.status, 'suspended');
  assert.equal(s.balance, 0);
  assert.equal(s.forfeited, 4000);
  assert.equal((await db().withdrawals.findOne({ _id: w.data.withdrawal.id })).status, 'rejected');
  await a.wait((m) => m.t === 'suspended');

  // Suspended: no games, no money movement, but support still works.
  assert.equal((await a.req('/api/wallet/withdraw', { coin: 'USDT', address: '0x' + 'c'.repeat(40), amount: 500 })).status, 403);
  assert.equal((await a.req('/api/wallet/deposit', { coin: 'USDT', amount: 500 })).status, 403);
  a.send({ t: 'queue-join', tc: 3, stake: 100 });
  assert.match((await a.wait((m) => m.t === 'error')).message, /suspended/i);
  assert.equal((await a.req('/api/tickets', { subject: 'Account suspension', body: 'I did not cheat, please review.' })).status, 200);
  await checkBooks(db());
  a.close();
});

test('fair-play stop mid-game: honest player gets the whole pot, earlier victims refunded only once staff approve', async () => {
  const cheat = await player(), victim = await player(), honest = await player();
  // Cheater beats the victim first.
  const g1 = await match(cheat, victim, 3, 500);
  await play(g1, ['e4', 'e5']);
  const loser1 = g1.white === cheat ? g1.black : g1.white;
  loser1.send({ t: 'resign', id: g1.id });
  await cheat.wait((m) => m.t === 'end');
  assert.equal(await victim.balance(), 9500);

  const g2 = await match(cheat, honest, 3, 1000);
  await play(g2, ['d4', 'd5']);
  const live = app.ctx.games.get(g2.id);
  await app.ctx.enforcement.intervene(live, live.colorOf(cheat.user.id), 'test');
  const end = await honest.wait((m) => m.t === 'end');
  assert.equal(end.game.reason, 'fair-play');
  assert.equal(await honest.balance(), 10_000 + 1000); // full pot, no rake
  assert.equal(await victim.balance(), 9500);          // nothing paid yet
  const c = await db().users.findOne({ _id: cheat.user.id });
  assert.equal(c.status, 'suspended');
  assert.equal(c.balance, 0);
  await checkBooks(db());

  // The refund waits in the admin page until staff decide.
  const claim = await db().refunds.findOne({ user_id: victim.user.id, status: 'pending' });
  assert.equal(claim.amount, 500);
  assert.equal(claim.cheater_id, cheat.user.id);
  assert.equal((await victim.req(`/api/admin/refunds/${claim.id}/approve`, {})).status, 404, 'players cannot approve');
  await db().users.update({ _id: honest.user.id }, { $set: { is_admin: 1 } });
  const o = await honest.req('/api/admin/overview');
  assert.ok(o.data.refunds.some((r) => r.id === claim.id && r.username === victim.user.username));
  assert.equal((await honest.req(`/api/admin/refunds/${claim.id}/approve`, {})).status, 200);
  assert.equal((await honest.req(`/api/admin/refunds/${claim.id}/approve`, {})).status, 409, 'paid once');
  assert.equal((await honest.req(`/api/admin/refunds/${claim.id}/decline`, {})).status, 409);
  assert.equal(await victim.balance(), 10_000);
  await db().users.update({ _id: honest.user.id }, { $set: { is_admin: 0 } });
  await checkBooks(db());
  cheat.close(); victim.close(); honest.close();
});

test('admin: hidden from players, can reinstate with balance', async () => {
  const p = await player(1000);
  assert.equal((await p.req('/api/admin/overview')).status, 404);
  await app.ctx.enforcement.suspend(p.user.id, 'test');
  assert.equal(await p.balance(), 0);
  await db().users.update({ _id: p.user.id }, { $set: { is_admin: 1 } }); // let them act on themselves for the test
  const o = await p.req('/api/admin/overview');
  assert.equal(o.status, 200);
  assert.ok(o.data.flagged.some((f) => f.id === p.user.id));
  const d = await p.req(`/api/admin/users/${p.user.id}`);
  assert.equal(d.data.user.forfeited, 1000);
  assert.equal((await p.req(`/api/admin/users/${p.user.id}/reinstate`, { restore: true })).status, 200);
  assert.equal(await p.balance(), 1000);
  await checkBooks(db());
  p.close();
});

test('restart: unfinished games are voided and every open stake is returned', async () => {
  const shared = { analysisPool: app.ctx.analysisPool };
  const one = await boot(shared);
  const [a, b, c] = [new Client(one.base), new Client(one.base), new Client(one.base)];
  for (const [cl, name] of [[a, 'restart_a'], [b, 'restart_b'], [c, 'restart_c']]) {
    await cl.register(name);
    await cl.fund(1000);
    await cl.connect();
  }
  // a and b are paired into a game; c is left waiting in another queue.
  a.send({ t: 'queue-join', tc: 3, stake: 100 });
  await a.wait((m) => m.t === 'queue' && m.state === 'joined');
  b.send({ t: 'queue-join', tc: 3, stake: 100 });
  await a.wait((m) => m.t === 'matched');
  c.send({ t: 'queue-join', tc: 10, stake: 500 });
  await c.wait((m) => m.t === 'queue' && m.state === 'joined');
  assert.equal(await a.balance(), 1000 - 100);
  assert.equal(await c.balance(), 1000 - 500);
  a.close(); b.close(); c.close();
  await one.close({ crash: true, keep: true }); // a crash: nothing gets to finish

  const two = await boot({ ...shared, dbName: one.dbName });
  assert.equal(two.recovered.games, 1);
  assert.equal(two.recovered.holds, 3);
  for (const name of ['restart_a', 'restart_b', 'restart_c']) assert.equal((await two.ctx.db.users.findOne({ username: name })).balance, 1000);
  await checkBooks(two.ctx.db);
  await two.close();
});

import { boot, Client, sleep, checkBooks } from './helpers.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.FIRST_MOVE_MS = '600';
process.env.ABANDON_MS_3 = '500';
process.env.BOT_WIN_SUSPEND_MIN_MS = '50';
process.env.BOT_WIN_SUSPEND_MAX_MS = '80';

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
  assert.ok(db().get("SELECT 1 FROM ledger WHERE user_id IS NULL AND kind = 'withdraw_fee' AND amount = 100"));
  checkBooks(db());
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
  checkBooks(db());
});

test('human game: checkmate pays the pot minus 4% rake', async () => {
  const a = await player(), b = await player();
  const g = await match(a, b, 3, 500);
  await play(g, ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']);
  const end = await g.white.wait((m) => m.t === 'end');
  assert.equal(end.game.result, '1-0');
  assert.equal(end.game.reason, 'checkmate');
  assert.equal(end.game.you, 'w');
  assert.equal(await g.white.balance(), 10_000 - 500 + 960);
  assert.equal(await g.black.balance(), 10_000 - 500);
  assert.equal(db().get('SELECT rake FROM games WHERE id = ?', g.id).rake, 40);
  checkBooks(db());
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
  assert.equal(await a.balance(), 10_000 - 40);
  assert.equal(await b.balance(), 10_000 - 40);
  checkBooks(db());
  a.close(); b.close();
});

test('no first move: game aborts and both stakes come back in full', async () => {
  const a = await player(), b = await player();
  await match(a, b, 3, 100);
  const end = await a.wait((m) => m.t === 'end', 4000);
  assert.equal(end.game.status, 'aborted');
  assert.equal(await a.balance(), 10_000);
  assert.equal(await b.balance(), 10_000);
  checkBooks(db());
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
  assert.ok(db().get("SELECT 1 FROM fair_play_events WHERE kind = 'multi_account' AND user_id = ?", b.user.id));
  const c = await player();
  c.send({ t: 'queue-join', tc: 10, stake: 100 });
  const m = await c.wait((x) => x.t === 'matched');
  assert.ok(m.id);
  a.send({ t: 'queue-leave' }); b.send({ t: 'queue-leave' });
  const live = app.ctx.games.get(m.id);
  live.end({ status: 'aborted', reason: 'aborted' });
  await sleep(100);
  a.close(); b.close(); c.close();
  checkBooks(db());
});

test('several people waiting are all paired, including shared networks and past shared browsers', async () => {
  // Four players in one queue: everyone must get a game.
  const ps = [];
  for (let i = 0; i < 4; i++) ps.push(await player(2000));
  // Two of them once signed in on the same browser, then moved to their own.
  db().run('INSERT INTO user_devices (user_id, device_id, ip, first_seen, last_seen) VALUES (?,?,?,?,?)', ps[0].user.id, 'f'.repeat(32), '127.0.0.1', Date.now(), Date.now());
  db().run('INSERT INTO user_devices (user_id, device_id, ip, first_seen, last_seen) VALUES (?,?,?,?,?)', ps[1].user.id, 'f'.repeat(32), '127.0.0.1', Date.now(), Date.now());
  for (const p of ps) p.send({ t: 'queue-join', tc: 3, stake: 500 });
  const ids = await Promise.all(ps.map((p) => p.wait((m) => m.t === 'matched', 4000).then((m) => m.id)));
  assert.equal(new Set(ids).size, 2, 'four players should make two games');
  assert.equal(app.ctx.matchmaker.counts()['3:500'], 0);
  for (const id of new Set(ids)) app.ctx.games.get(id).end({ status: 'aborted', reason: 'aborted' });
  // Just the two who once shared a browser (now on their own): still paired.
  ps[0].send({ t: 'queue-join', tc: 10, stake: 500 });
  ps[1].send({ t: 'queue-join', tc: 10, stake: 500 });
  const m = await ps[0].wait((x) => x.t === 'matched', 4000);
  const live = app.ctx.games.get(m.id);
  assert.deepEqual([live.white.userId, live.black.userId].sort(), [ps[0].user.id, ps[1].user.id].sort());
  live.end({ status: 'aborted', reason: 'aborted' });
  await sleep(50);
  ps.forEach((p) => p.close());
  checkBooks(db());
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
  assert.equal(db().get("SELECT COUNT(*) n FROM games WHERE status = 'finished' AND (white_id = ? OR black_id = ?)", a.user.id, a.user.id).n, 4);
  a.close(); b.close();
  checkBooks(db());
});

test('with a choice, the matchmaker avoids a repeat opponent', async () => {
  const a = await player(), b = await player();
  const g = await match(a, b, 10, 500);
  await play(g, ['e4', 'e5']);
  g.white.send({ t: 'resign', id: g.id });
  await a.wait((m) => m.t === 'end'); await b.wait((m) => m.t === 'end');
  const row = (p) => db().get('SELECT * FROM users WHERE id = ?', p.user.id);
  for (let trial = 0; trial < 8; trial++) {
    const c = await player(2000);
    const before = new Set(app.ctx.games.live.keys());
    // Join all three and pair synchronously, so the timer can't interleave.
    for (const p of [a, b, c]) app.ctx.matchmaker.join(row(p), 10, 1000, {});
    app.ctx.matchmaker.tick();
    const fresh = [...app.ctx.games.live.values()].filter((x) => !before.has(x.id));
    assert.equal(fresh.length, 1);
    const seats = [fresh[0].white.userId, fresh[0].black.userId];
    assert.ok(seats.includes(c.user.id), `trial ${trial}: paired the two players who just met`);
    fresh[0].end({ status: 'aborted', reason: 'aborted' });
    for (const p of [a, b]) app.ctx.matchmaker.leave(p.user.id);
    db().run('DELETE FROM games WHERE id = ?', fresh[0].id); // keep c's history out of later trials
    c.close();
  }
  a.close(); b.close();
  checkBooks(db());
});

test('bot game: real engine replies, resigning gives the house the stake', async () => {
  const a = await player();
  const r = await a.req('/api/bots/play', { bot: 'hikaru', stake: 700, color: 'w' });
  assert.equal(r.status, 200);
  a.send({ t: 'sub', id: r.data.id });
  const gm = await a.wait((m) => m.t === 'game');
  assert.equal(gm.game.you, 'w');
  assert.equal(gm.game.black.bot, 'hikaru');
  a.send({ t: 'move', id: r.data.id, u: 'a2a3', ply: 0 }); // out of book: engine must answer
  await a.wait((m) => m.t === 'move' && m.ply === 1);
  const reply = await a.wait((m) => m.t === 'move' && m.ply === 2, 10_000);
  assert.match(reply.u, /^[a-h][1-8][a-h][1-8]/);
  assert.equal((await a.req('/api/bots/play', { bot: 'magnus', stake: 100 })).status, 409);
  a.send({ t: 'resign', id: r.data.id });
  await a.wait((m) => m.t === 'end');
  assert.equal(await a.balance(), 10_000 - 700);
  assert.ok(db().get("SELECT 1 FROM ledger WHERE user_id IS NULL AND kind = 'bot_win' AND amount = 700"));
  checkBooks(db());
  a.close();
});

test('bot stake limits', async () => {
  const a = await player(20_000);
  assert.equal((await a.req('/api/bots/play', { bot: 'magnus', stake: 50 })).status, 400);
  assert.equal((await a.req('/api/bots/play', { bot: 'magnus', stake: 10_001 })).status, 400);
  assert.equal((await a.req('/api/bots/play', { bot: 'nobody', stake: 100 })).status, 400);
  a.close();
});

test('beating a bot: paid 2x, withdrawals held, suspended hours later, balance forfeited', async () => {
  const a = await player(5000);
  const r = await a.req('/api/bots/play', { bot: 'kasparov', stake: 1000, color: 'w' });
  const live = app.ctx.games.get(r.data.id);
  live.moves.push({ u: 'e2e4', s: 'e4', t: 1000 }, { u: 'e7e5', s: 'e5', t: 1000 });
  live.end({ result: '1-0', reason: 'checkmate' }); // stand-in for a real win
  assert.equal(await a.balance(), 5000 - 1000 + 2000);
  const u = db().get('SELECT * FROM users WHERE id = ?', a.user.id);
  assert.equal(u.review, 1);
  assert.equal(u.status, 'active');
  const pending = db().get("SELECT * FROM scheduled_actions WHERE user_id = ? AND status = 'pending'", a.user.id);
  assert.ok(pending && pending.kind === 'suspend');

  // Withdrawal goes into review instead of out.
  const w = await a.req('/api/wallet/withdraw', { coin: 'USDT', address: '0x' + 'c'.repeat(40), amount: 1000 });
  assert.equal(w.data.withdrawal.status, 'review');

  await sleep(120);
  app.ctx.enforcement.tick();
  const s = db().get('SELECT * FROM users WHERE id = ?', a.user.id);
  assert.equal(s.status, 'suspended');
  assert.equal(s.balance, 0);
  assert.equal(s.forfeited, 5000);
  assert.equal(db().get('SELECT status FROM withdrawals WHERE id = ?', w.data.withdrawal.id).status, 'rejected');
  await a.wait((m) => m.t === 'suspended');

  // Suspended: no games, no money movement, but support still works.
  assert.equal((await a.req('/api/bots/play', { bot: 'magnus', stake: 100 })).status, 403);
  assert.equal((await a.req('/api/wallet/withdraw', { coin: 'USDT', address: '0x' + 'c'.repeat(40), amount: 500 })).status, 403);
  assert.equal((await a.req('/api/wallet/deposit', { coin: 'USDT', amount: 500 })).status, 403);
  a.send({ t: 'queue-join', tc: 3, stake: 100 });
  assert.match((await a.wait((m) => m.t === 'error')).message, /suspended/i);
  assert.equal((await a.req('/api/tickets', { subject: 'Account suspension', body: 'I did not cheat, please review.' })).status, 200);
  checkBooks(db());
  a.close();
});

test('fair-play stop mid-game: honest player gets the whole pot, earlier victims refunded', async () => {
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
  app.ctx.enforcement.intervene(live, live.colorOf(cheat.user.id), 'test');
  const end = await honest.wait((m) => m.t === 'end');
  assert.equal(end.game.reason, 'fair-play');
  assert.equal(await honest.balance(), 10_000 + 1000); // full pot, no rake
  assert.equal(await victim.balance(), 10_000);        // refunded
  const c = db().get('SELECT status, balance FROM users WHERE id = ?', cheat.user.id);
  assert.equal(c.status, 'suspended');
  assert.equal(c.balance, 0);
  checkBooks(db());
  cheat.close(); victim.close(); honest.close();
});

test('admin: hidden from players, can reinstate with balance', async () => {
  const p = await player(1000);
  assert.equal((await p.req('/api/admin/overview')).status, 404);
  app.ctx.enforcement.suspend(p.user.id, 'test');
  assert.equal(await p.balance(), 0);
  db().run('UPDATE users SET is_admin = 1 WHERE id = ?', p.user.id); // let them act on themselves for the test
  const o = await p.req('/api/admin/overview');
  assert.equal(o.status, 200);
  assert.ok(o.data.flagged.some((f) => f.id === p.user.id));
  const d = await p.req(`/api/admin/users/${p.user.id}`);
  assert.equal(d.data.user.forfeited, 1000);
  assert.equal((await p.req(`/api/admin/users/${p.user.id}/reinstate`, { restore: true })).status, 200);
  assert.equal(await p.balance(), 1000);
  checkBooks(db());
  p.close();
});

test('restart: unfinished games are voided and every open stake is returned', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-'));
  const file = path.join(dir, 'r.db');
  const { createApp } = await import('../src/app.js');
  const one = await createApp({ dbPath: file, botPool: app.ctx.botPool, analysisPool: app.ctx.analysisPool });
  await new Promise((r) => one.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${one.server.address().port}`;
  const a = new Client(base);
  await a.register('restart_a');
  await a.fund(1000);
  await a.connect();
  a.send({ t: 'queue-join', tc: 3, stake: 500 });
  await a.wait((m) => m.t === 'queue');
  const r = await a.req('/api/bots/play', { bot: 'magnus', stake: 300 });
  assert.equal(r.status, 200);
  assert.equal(await a.balance(), 1000 - 300); // joining a bot game leaves the queue
  a.close();
  // Simulate a crash: stop timers, keep the DB as is.
  one.ctx.fairplay.closed = true; one.ctx.matchmaker.stop(); one.ctx.enforcement.stop(); one.ctx.games.shutdown(); one.ctx.hub.close();
  await new Promise((res) => one.server.close(res));
  one.ctx.db.close();

  const two = await createApp({ dbPath: file, botPool: app.ctx.botPool, analysisPool: app.ctx.analysisPool });
  assert.equal(two.recovered.games, 1);
  assert.equal(two.recovered.holds, 1);
  assert.equal(two.ctx.db.get("SELECT balance FROM users WHERE username = 'restart_a'").balance, 1000);
  checkBooks(two.ctx.db);
  two.ctx.matchmaker.stop(); two.ctx.enforcement.stop(); two.ctx.hub.close?.();
  two.ctx.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

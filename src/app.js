import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { openDb } from './db.js';
import { createMoney, MoneyError, humanPayouts } from './money.js';
import { EnginePool } from './engine.js';
import { createHub, CHAT_PRESETS } from './hub.js';
import { createGames, feedShape } from './games.js';
import { createMatchmaker } from './matchmaking.js';
import { createEnforcement } from './enforcement.js';
import { createWallet, coinList, COINS } from './wallet.js';
import { FairPlay, MODEL, accountEvidence } from './anticheat.js';
import { botList, BOTS } from './bots.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- passwords & sessions ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
function checkPassword(pw, stored) {
  const [, salt, key] = String(stored).split('$');
  if (!salt || !key) return false;
  const want = Buffer.from(key, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function clientIp(req) {
  const fwd = config.prod ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return fwd || req.socket.remoteAddress || '';
}

// Tiny fixed-window limiter for the auth endpoints.
function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const t = Date.now();
    const h = hits.get(key);
    if (!h || t - h.at > windowMs) { hits.set(key, { at: t, n: 1 }); return true; }
    h.n++;
    return h.n <= max;
  };
}

export async function createApp(opts = {}) {
  const ctx = { queueGrace: new Map() };
  const db = (ctx.db = openDb(opts.dbPath || config.dbPath));
  ctx.money = createMoney(db);
  ctx.hub = createHub(ctx);
  ctx.botPool = opts.botPool || new EnginePool(config.botEngines, config.stockfishPath, { Threads: config.botThreads, Hash: config.botHashMb });
  ctx.analysisPool = opts.analysisPool || new EnginePool(config.analysisEngines, config.stockfishPath, { Threads: 1, Hash: 32 });
  ctx.games = createGames(ctx);
  ctx.matchmaker = createMatchmaker(ctx);
  ctx.wallet = createWallet(ctx);
  ctx.enforcement = createEnforcement(ctx);
  ctx.fairplay = new FairPlay({ db, pool: ctx.analysisPool, nodes: opts.analysisNodes || config.analysisNodes, enforce: ctx.enforcement });

  const recovered = ctx.games.recover();
  ctx.wallet.resumePending();
  ctx.enforcement.tick();

  for (const name of config.adminUsers) db.run('UPDATE users SET is_admin = 1 WHERE username_lc = ?', name);

  // ---- auth helpers ----
  function userFromToken(token) {
    if (!token) return null;
    const s = db.get('SELECT * FROM sessions WHERE token_hash = ?', sha(token));
    if (!s || s.expires_at < Date.now()) return null;
    return db.get('SELECT * FROM users WHERE id = ?', s.user_id) || null;
  }

  const api = (ctx.api = {
    authFromRequest(req) {
      const c = parseCookies(req.headers.cookie);
      return { user: userFromToken(c.cbs), device: /^[a-f0-9]{32}$/.test(c.cbd || '') ? c.cbd : null, ip: clientIp(req) };
    },
    sameOrigin(origin, host) {
      try { return new URL(origin).host === host; } catch { return false; }
    },
    hello(userId) {
      const base = { t: 'hello', queues: ctx.matchmaker.counts(), online: ctx.hub.online() };
      if (!userId) return { ...base, user: null };
      const u = db.get('SELECT * FROM users WHERE id = ?', userId);
      const g = ctx.games.activeFor(userId);
      return { ...base, user: publicUser(u), queue: ctx.matchmaker.status(userId), activeGame: g ? g.id : null };
    },
    gameRow(id, viewerId) {
      const r = db.get(`SELECT g.*, w.username wn, b.username bn FROM games g LEFT JOIN users w ON w.id = g.white_id LEFT JOIN users b ON b.id = g.black_id WHERE g.id = ?`, id);
      if (!r || r.status === 'active') return null;
      const moves = JSON.parse(r.moves);
      const side = (c) => {
        const uid = c === 'w' ? r.white_id : r.black_id;
        if (!uid && r.bot) return { bot: r.bot, name: BOTS[r.bot]?.name, fullName: BOTS[r.bot]?.fullName };
        return { userId: uid, name: c === 'w' ? r.wn : r.bn };
      };
      const you = viewerId && r.white_id === viewerId ? 'w' : viewerId && r.black_id === viewerId ? 'b' : null;
      return {
        id: r.id, kind: r.kind, tc: r.tc, stake: r.stake,
        payouts: r.kind === 'human' ? humanPayouts(r.stake) : { win: r.stake * 2, draw: r.stake },
        white: side('w'), black: side('b'), you,
        fen: r.fen, moves: moves.map((m) => ({ u: m.u, s: m.s })),
        clocks: { w: moves.filter((_, i) => i % 2 === 0).at(-1)?.c ?? r.tc * 60_000, b: moves.filter((_, i) => i % 2 === 1).at(-1)?.c ?? r.tc * 60_000 },
        running: false, turn: moves.length % 2 ? 'b' : 'w', status: r.status, result: r.result, reason: r.reason,
        settlement: { rake: r.rake, w: r.payout_white, b: r.payout_black }, chat: [], gone: {}, serverNow: Date.now(),
        createdAt: r.created_at, endedAt: r.ended_at,
      };
    },
  });

  function publicUser(u) {
    if (!u) return null;
    return {
      id: u.id, username: u.username, balance: u.balance, held: ctx.money.heldTotal(u.id),
      status: u.status, suspendedAt: u.suspended_at, isAdmin: !!u.is_admin, createdAt: u.created_at,
    };
  }

  // ---- express ----
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    next();
  });

  // Every browser gets a random device id. It is how two accounts on one
  // machine are kept apart in matchmaking.
  app.use((req, res, next) => {
    const c = parseCookies(req.headers.cookie);
    req.cookies = c;
    if (!/^[a-f0-9]{32}$/.test(c.cbd || '')) {
      c.cbd = crypto.randomBytes(16).toString('hex');
      res.append('Set-Cookie', `cbd=${c.cbd}; Path=/; Max-Age=${2 * 365 * 86400}; HttpOnly; SameSite=Lax${config.prod ? '; Secure' : ''}`);
    }
    req.device = c.cbd;
    req.ip2 = clientIp(req);
    req.user = userFromToken(c.cbs);
    next();
  });

  app.use('/api', express.json({ limit: '24kb' }));

  // CSRF: state-changing calls must carry a header a cross-site form cannot set.
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET') return next();
    if (req.get('x-cb') !== '1') return res.status(403).json({ error: 'Bad request' });
    const origin = req.get('origin');
    if (origin && !api.sameOrigin(origin, req.get('host'))) return res.status(403).json({ error: 'Bad origin' });
    next();
  });

  const needUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Sign in first' }));
  const needActive = (req, res, next) => (req.user?.status === 'active' ? next() : res.status(403).json({ error: 'Your account is suspended. Contact support.', code: 'suspended' }));
  const needAdmin = (req, res, next) => (req.user?.is_admin ? next() : res.status(404).json({ error: 'Not found' }));
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      if (e instanceof MoneyError || e.status) return res.status(e.status || 400).json({ error: e.message, code: e.code });
      console.error(e);
      res.status(500).json({ error: 'Something went wrong' });
    }
  };

  function startSession(res, user, req) {
    const token = crypto.randomBytes(32).toString('base64url');
    const t = Date.now();
    db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, ua) VALUES (?,?,?,?,?,?)',
      sha(token), user.id, t, t + config.sessionDays * 86_400_000, req.ip2, String(req.get('user-agent') || '').slice(0, 200));
    db.run('UPDATE users SET last_ip = ?, last_seen = ? WHERE id = ?', req.ip2, t, user.id);
    ctx.enforcement.seenDevice(user.id, req.device, req.ip2);
    res.append('Set-Cookie', `cbs=${token}; Path=/; Max-Age=${config.sessionDays * 86400}; HttpOnly; SameSite=Lax${config.prod ? '; Secure' : ''}`);
  }

  const authLimit = limiter(config.loginPerMinute, 60_000);
  const registerLimit = limiter(config.registerPerHour, 3600_000);

  app.post('/api/register', wrap(async (req, res) => {
    if (!registerLimit(req.ip2)) return res.status(429).json({ error: 'Too many sign-ups from this network. Try later.' });
    const { username, password, adult, terms } = req.body || {};
    const name = String(username || '').trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return res.status(400).json({ error: 'Username must be 3 to 16 letters, numbers or underscores', field: 'username' });
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be at least 8 characters', field: 'password' });
    if (adult !== true || terms !== true) return res.status(400).json({ error: 'Confirm you are 18 or older and accept the terms', field: 'terms' });
    if (db.get('SELECT 1 FROM users WHERE username_lc = ?', name.toLowerCase())) return res.status(409).json({ error: 'That username is taken', field: 'username' });
    const isAdmin = config.adminUsers.includes(name.toLowerCase()) ? 1 : 0;
    const r = db.run('INSERT INTO users (username, username_lc, pass_hash, created_at, created_ip, device_id, is_admin) VALUES (?,?,?,?,?,?,?)',
      name, name.toLowerCase(), hashPassword(password), Date.now(), req.ip2, req.device, isAdmin);
    const user = db.get('SELECT * FROM users WHERE id = ?', Number(r.lastInsertRowid));
    startSession(res, user, req);
    res.json({ user: publicUser(user) });
  }));

  app.post('/api/login', wrap(async (req, res) => {
    if (!authLimit(req.ip2)) return res.status(429).json({ error: 'Too many attempts. Wait a minute.' });
    const { username, password } = req.body || {};
    const user = db.get('SELECT * FROM users WHERE username_lc = ?', String(username || '').trim().toLowerCase());
    if (!user || typeof password !== 'string' || !checkPassword(password, user.pass_hash)) return res.status(401).json({ error: 'Wrong username or password' });
    startSession(res, user, req);
    res.json({ user: publicUser(user) });
  }));

  app.post('/api/logout', (req, res) => {
    if (req.cookies.cbs) db.run('DELETE FROM sessions WHERE token_hash = ?', sha(req.cookies.cbs));
    res.append('Set-Cookie', 'cbs=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    const g = req.user ? ctx.games.activeFor(req.user.id) : null;
    res.json({ user: publicUser(req.user), activeGame: g?.id || null, queue: req.user ? ctx.matchmaker.status(req.user.id) : null });
  });

  app.get('/api/config', (req, res) => {
    res.json({
      queues: config.timeControls.flatMap((tc) => config.stakes.map((stake) => ({ key: `${tc}:${stake}`, tc, stake, ...humanPayouts(stake) }))),
      rakeBps: config.rakeBps,
      withdrawFeeBps: config.withdrawFeeBps,
      minWithdraw: config.minWithdraw,
      bots: botList(),
      bot: { minutes: config.botMinutes, min: config.botStakeMin, max: config.botStakeMax },
      coins: coinList(),
      chat: CHAT_PRESETS,
      counts: ctx.matchmaker.counts(),
    });
  });

  // ---- games ----
  app.post('/api/bots/play', needUser, needActive, wrap(async (req, res) => {
    const { bot, stake, color } = req.body || {};
    const cents = Math.round(Number(stake));
    if (!BOTS[bot]) return res.status(400).json({ error: 'Pick a bot' });
    if (!Number.isInteger(cents) || cents < config.botStakeMin || cents > config.botStakeMax) return res.status(400).json({ error: 'Wager must be between $1 and $100' });
    if (ctx.games.activeFor(req.user.id)) return res.status(409).json({ error: 'Finish your current game first', game: ctx.games.activeFor(req.user.id).id });
    if (ctx.matchmaker.status(req.user.id)) ctx.matchmaker.leave(req.user.id, 'bot-game');
    const g = ctx.games.createBot(req.user, bot, cents, color, { ip: req.ip2, device: req.device });
    ctx.hub.pushBalance(req.user.id);
    res.json({ id: g.id });
  }));

  app.get('/api/games/:id', (req, res) => {
    const g = ctx.games.get(req.params.id);
    if (g) {
      const color = req.user ? g.colorOf(req.user.id) : null;
      if (g.status === 'active' && !color) return res.status(403).json({ error: 'Live games are private to the two players' });
      return res.json({ game: g.snapshot(req.user?.id) });
    }
    const row = api.gameRow(req.params.id, req.user?.id);
    if (!row) return res.status(404).json({ error: 'Game not found' });
    res.json({ game: row });
  });

  app.get('/api/my/games', needUser, (req, res) => {
    const rows = db.all(
      `SELECT g.id, g.kind, g.tc, g.stake, g.bot, g.status, g.result, g.reason, g.white_id, g.black_id, g.payout_white, g.payout_black,
              g.created_at, g.ended_at, json_array_length(g.moves) plies, w.username wn, b.username bn
       FROM games g LEFT JOIN users w ON w.id = g.white_id LEFT JOIN users b ON b.id = g.black_id
       WHERE (g.white_id = ? OR g.black_id = ?) AND g.status != 'active' ORDER BY g.created_at DESC LIMIT 100`,
      req.user.id, req.user.id,
    );
    res.json({
      games: rows.map((r) => {
        const color = r.white_id === req.user.id ? 'w' : 'b';
        const opp = r.kind === 'bot' ? BOTS[r.bot]?.name : color === 'w' ? r.bn : r.wn;
        const payout = color === 'w' ? r.payout_white : r.payout_black;
        const outcome = r.status === 'aborted' ? 'aborted' : r.result === '1/2-1/2' ? 'draw' : (r.result === '1-0') === (color === 'w') ? 'win' : 'loss';
        return { id: r.id, kind: r.kind, tc: r.tc, stake: r.stake, color, opponent: opp, bot: r.bot, outcome, reason: r.reason, payout, plies: r.plies, at: r.ended_at || r.created_at };
      }),
    });
  });

  app.get('/api/feed', (req, res) => {
    const filter = req.query.f === 'high' ? 'AND g.stake >= 1000' : '';
    const rows = db.all(
      `SELECT g.*, w.username wn, b.username bn FROM games g LEFT JOIN users w ON w.id = g.white_id LEFT JOIN users b ON b.id = g.black_id
       WHERE g.status = 'finished' ${filter} ORDER BY g.ended_at DESC LIMIT 20`,
    );
    res.json({ rows: rows.flatMap(feedShape).slice(0, 20) });
  });

  app.get('/api/stats', (req, res) => {
    const day = Date.now() - 86_400_000;
    res.json({
      online: ctx.hub.online(),
      playing: [...ctx.games.live.values()].filter((g) => g.status === 'active').length,
      games24h: db.get("SELECT COUNT(*) n FROM games WHERE status = 'finished' AND ended_at > ?", day).n,
      wagered24h: db.get("SELECT COALESCE(SUM(stake * CASE kind WHEN 'human' THEN 2 ELSE 1 END),0) s FROM games WHERE status = 'finished' AND ended_at > ?", day).s,
    });
  });

  // ---- wallet ----
  app.get('/api/wallet', needUser, (req, res) => {
    res.json({ ...ctx.wallet.overview(req.user.id), user: publicUser(req.user), coins: coinList(), feeBps: config.withdrawFeeBps, minWithdraw: config.minWithdraw });
  });
  app.post('/api/wallet/address', needUser, needActive, wrap(async (req, res) => {
    res.json(await ctx.wallet.address(req.user.id, String(req.body?.coin || '')));
  }));
  app.post('/api/wallet/deposit', needUser, needActive, wrap(async (req, res) => {
    const amount = Math.round(Number(req.body?.amount));
    res.json({ deposit: ctx.wallet.testDeposit(req.user, String(req.body?.coin || ''), amount) });
  }));
  app.post('/api/wallet/withdraw', needUser, needActive, wrap(async (req, res) => {
    const amount = Math.round(Number(req.body?.amount));
    const w = ctx.wallet.withdraw(req.user, String(req.body?.coin || ''), req.body?.address, amount);
    res.json({ withdrawal: w, user: publicUser(db.get('SELECT * FROM users WHERE id = ?', req.user.id)) });
  }));

  // ---- support ----
  app.get('/api/tickets', needUser, (req, res) => {
    const tickets = db.all('SELECT * FROM tickets WHERE user_id = ? ORDER BY updated_at DESC', req.user.id);
    for (const t of tickets) t.messages = db.all('SELECT author, body, created_at FROM ticket_messages WHERE ticket_id = ? ORDER BY id', t.id);
    res.json({ tickets });
  });
  app.post('/api/tickets', needUser, wrap(async (req, res) => {
    const subject = String(req.body?.subject || '').trim().slice(0, 120);
    const body = String(req.body?.body || '').trim().slice(0, 4000);
    if (subject.length < 3 || body.length < 10) return res.status(400).json({ error: 'Add a subject and a few words about the problem' });
    const open = db.get("SELECT COUNT(*) n FROM tickets WHERE user_id = ? AND status = 'open'", req.user.id).n;
    if (open >= 5) return res.status(429).json({ error: 'You already have 5 open tickets' });
    const t = Date.now();
    const r = db.run('INSERT INTO tickets (user_id, subject, created_at, updated_at) VALUES (?,?,?,?)', req.user.id, subject, t, t);
    db.run('INSERT INTO ticket_messages (ticket_id, author, body, created_at) VALUES (?,?,?,?)', Number(r.lastInsertRowid), 'user', body, t);
    res.json({ id: Number(r.lastInsertRowid) });
  }));
  app.post('/api/tickets/:id/reply', needUser, wrap(async (req, res) => {
    const t = db.get('SELECT * FROM tickets WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    const body = String(req.body?.body || '').trim().slice(0, 4000);
    if (!body) return res.status(400).json({ error: 'Write a message' });
    db.run('INSERT INTO ticket_messages (ticket_id, author, body, created_at) VALUES (?,?,?,?)', t.id, 'user', body, Date.now());
    db.run("UPDATE tickets SET status = 'open', updated_at = ? WHERE id = ?", Date.now(), t.id);
    res.json({ ok: true });
  }));

  // ---- admin ----
  app.get('/api/admin/overview', needUser, needAdmin, (req, res) => {
    const house = db.all('SELECT kind, SUM(amount) total, COUNT(*) n FROM ledger WHERE user_id IS NULL GROUP BY kind');
    const flagged = db.all(
      `SELECT u.id, u.username, u.status, u.review, u.balance, u.suspend_reason,
              (SELECT MAX(evidence) FROM fair_play_reports r WHERE r.user_id = u.id) maxEvidence,
              (SELECT COUNT(*) FROM fair_play_events e WHERE e.user_id = u.id) events
       FROM users u WHERE u.review = 1 OR u.status = 'suspended' ORDER BY u.id DESC LIMIT 100`,
    );
    const pending = db.all(`SELECT a.*, u.username FROM scheduled_actions a JOIN users u ON u.id = a.user_id WHERE a.status = 'pending' ORDER BY run_at`);
    res.json({
      house, flagged, pending,
      totals: {
        users: db.get('SELECT COUNT(*) n FROM users').n,
        balances: db.get('SELECT COALESCE(SUM(balance),0) s FROM users').s,
        held: db.get("SELECT COALESCE(SUM(amount),0) s FROM holds WHERE status = 'held'").s,
        games: db.get("SELECT COUNT(*) n FROM games WHERE status = 'finished'").n,
        openTickets: db.get("SELECT COUNT(*) n FROM tickets WHERE status = 'open'").n,
      },
      model: MODEL,
    });
  });
  app.get('/api/admin/users', needUser, needAdmin, (req, res) => {
    const q = `%${String(req.query.q || '').toLowerCase()}%`;
    res.json({ users: db.all('SELECT id, username, balance, status, review, created_at, last_ip FROM users WHERE username_lc LIKE ? ORDER BY id DESC LIMIT 50', q) });
  });
  app.get('/api/admin/users/:id', needUser, needAdmin, (req, res) => {
    const id = Number(req.params.id);
    const u = db.get('SELECT id, username, balance, status, review, forfeited, suspend_reason, suspended_at, created_at, created_ip, last_ip FROM users WHERE id = ?', id);
    if (!u) return res.status(404).json({ error: 'No such user' });
    const reports = db.all('SELECT game_id, evidence, verdict, metrics, created_at FROM fair_play_reports WHERE user_id = ? ORDER BY id DESC LIMIT 30', id)
      .map((r) => ({ ...r, metrics: JSON.parse(r.metrics) }));
    res.json({
      user: u,
      account: accountEvidence(reports.slice(0, MODEL.historyGames).map((r) => r.metrics)),
      reports,
      events: db.all('SELECT game_id, kind, detail, created_at FROM fair_play_events WHERE user_id = ? ORDER BY id DESC LIMIT 100', id),
      devices: db.all(`SELECT d.device_id, d.ip, d.last_seen, (SELECT GROUP_CONCAT(u2.username) FROM user_devices d2 JOIN users u2 ON u2.id = d2.user_id WHERE d2.device_id = d.device_id AND d2.user_id != d.user_id) shared
                       FROM user_devices d WHERE d.user_id = ?`, id),
      ledger: db.all('SELECT kind, amount, balance_after, ref, note, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 50', id),
      pending: db.all("SELECT * FROM scheduled_actions WHERE user_id = ? AND status = 'pending'", id),
    });
  });
  app.post('/api/admin/users/:id/suspend', needUser, needAdmin, wrap(async (req, res) => {
    const reason = String(req.body?.reason || 'Suspended by staff').slice(0, 300);
    res.json({ ok: ctx.enforcement.suspend(Number(req.params.id), reason, null, { refund: req.body?.refund !== false }) });
  }));
  app.post('/api/admin/users/:id/reinstate', needUser, needAdmin, wrap(async (req, res) => {
    res.json({ ok: ctx.enforcement.reinstate(Number(req.params.id), { restore: !!req.body?.restore }) });
  }));
  app.post('/api/admin/users/:id/clear-review', needUser, needAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    db.run("UPDATE scheduled_actions SET status = 'cancelled', done_at = ? WHERE user_id = ? AND status = 'pending'", Date.now(), id);
    ctx.enforcement.clearReview(id);
    res.json({ ok: true });
  }));
  app.get('/api/admin/tickets', needUser, needAdmin, (req, res) => {
    const tickets = db.all(`SELECT t.*, u.username, u.status user_status FROM tickets t JOIN users u ON u.id = t.user_id ORDER BY t.status = 'open' DESC, t.updated_at DESC LIMIT 100`);
    for (const t of tickets) t.messages = db.all('SELECT author, body, created_at FROM ticket_messages WHERE ticket_id = ? ORDER BY id', t.id);
    res.json({ tickets });
  });
  app.post('/api/admin/tickets/:id/reply', needUser, needAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const t = db.get('SELECT * FROM tickets WHERE id = ?', id);
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    const body = String(req.body?.body || '').trim().slice(0, 4000);
    if (body) db.run('INSERT INTO ticket_messages (ticket_id, author, body, created_at) VALUES (?,?,?,?)', id, 'staff', body, Date.now());
    db.run('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?', req.body?.close ? 'closed' : 'answered', Date.now(), id);
    ctx.hub.toUser(t.user_id, { t: 'notice', kind: 'ticket', id });
    res.json({ ok: true });
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ---- static ----
  app.get('/vendor/chess.js', (req, res) => {
    res.type('application/javascript').sendFile(path.join(ROOT, 'node_modules/chess.js/dist/esm/chess.js'));
  });
  app.use(express.static(path.join(ROOT, 'public'), { index: false, maxAge: config.prod ? '1h' : 0 }));
  app.get(/^\/(?!api|ws|vendor).*/, (req, res) => res.sendFile(path.join(ROOT, 'public/index.html')));

  const server = http.createServer(app);
  ctx.hub.attach(server);

  ctx.close = async () => {
    ctx.closed = true;
    ctx.fairplay.closed = true;
    ctx.matchmaker.stop();
    ctx.enforcement.stop();
    ctx.games.shutdown();
    ctx.hub.close?.();
    await new Promise((r) => server.close(() => r()));
    if (!opts.botPool) ctx.botPool.quit();
    if (!opts.analysisPool) ctx.analysisPool.quit();
    db.close();
  };

  return { app, server, ctx, recovered };
}

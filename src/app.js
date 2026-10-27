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
import { createWallet } from './wallet.js';
import { btcWallet, tronAddressOk } from './chain.js';
import { FairPlay, MODEL, accountEvidence } from './anticheat.js';

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

// Paper and real balances never share a database: a paper balance must not
// become withdrawable money. The first start records the mode; starting the
// other mode on that database is refused.
async function checkMode(db) {
  const counters = db.raw.collection('counters');
  const mark = await counters.findOne({ _id: 'payments_mode' });
  const name = db.raw.databaseName;
  if (mark && mark.mode !== config.payments) {
    throw new Error(mark.mode === 'paper'
      ? `Database "${name}" holds paper-money accounts, so it can't take real payments. Set MONGODB_DB to a new name for real money (for example ${name}_real).`
      : `Database "${name}" holds real-money accounts, so it can't run on paper money. Use a different MONGODB_DB for paper money.`);
  }
  if (!mark) {
    if (config.payments === 'crypto' && (await db.deposits.count({ kind: { $exists: false } }))) {
      throw new Error(`Database "${name}" has paper-money deposits in it. Set MONGODB_DB to a new name for real money (for example ${name}_real).`);
    }
    await counters.updateOne({ _id: 'payments_mode' }, { $setOnInsert: { mode: config.payments, at: Date.now() } }, { upsert: true });
  }
}

// What players see while an admin has the site switched off: one box,
// nothing to click.
const MAINTENANCE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ChessBets is unavailable</title><link rel="icon" href="/favicon.svg">
<style>
@font-face { font-family: Figtree; src: url(/fonts/figtree.woff2) format('woff2'); font-weight: 300 900; }
html, body { margin: 0; height: 100%; background: #0f212e; color: #fff; font-family: Figtree, system-ui, sans-serif; }
body { display: grid; place-items: center; padding: 16px; box-sizing: border-box; user-select: none; }
.box { background: #213743; border-radius: 12px; padding: 40px 32px; max-width: 440px; width: 100%; box-sizing: border-box; text-align: center; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45); }
.mark { width: 48px; height: 48px; margin: 0 auto 18px; }
h1 { font-size: 26px; margin: 0 0 10px; }
p { color: #b1bad3; font-size: 15px; font-weight: 500; line-height: 1.5; margin: 0; }
</style></head>
<body><div class="box" role="alertdialog" aria-labelledby="t">
<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><path fill="#00e701" d="M9 27h13.5l-.9-3.4c2.7-2.6 3.7-5.7 3.7-8.9 0-5-3.8-8.2-8.9-8.2L15 4.8l-1.1 2.4C10.8 8.3 9.2 10.5 8.3 12.8L5 16.3l1.7 2.3 3.6-1c1-.3 2-.1 2.6.4-2 2.4-3.8 5.3-3.9 9Z"/></svg>
<h1 id="t">ChessBets is unavailable</h1>
<p>The site is unavailable right now. Please check back later.</p>
</div></body></html>`;

const escapeRegex = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function createApp(opts = {}) {
  if (config.payments === 'crypto') {
    if (!config.btcXpub && !config.tronAddress) throw new Error('PAYMENTS=crypto needs BTC_XPUB, TRON_ADDRESS, or both (see README).');
    if (config.tronAddress && !tronAddressOk(config.tronAddress)) throw new Error('TRON_ADDRESS is not a valid Tron address (it starts with T).');
    if (config.btcXpub) btcWallet(config.btcXpub); // throws a readable error for a bad key
  }
  const ctx = { queueGrace: new Map() };
  const db = (ctx.db = await openDb({ uri: opts.mongoUri || config.mongoUri, name: opts.dbName || config.mongoDb }));
  try {
    await checkMode(db);
  } catch (e) {
    await db.close();
    throw e;
  }

  // Background work (game writes, deposits, analysis) registers here so a
  // shutdown can wait for it before closing the connection.
  const pending = new Set();
  ctx.track = (p) => {
    if (!p?.then) return p;
    pending.add(p);
    p.then(() => pending.delete(p), () => pending.delete(p));
    return p;
  };
  // One stake-taking action per user at a time (queue joins, deposit addresses).
  const locks = new Map();
  ctx.userLock = (userId, fn) => {
    const run = (locks.get(userId) || Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    locks.set(userId, tail);
    tail.then(() => { if (locks.get(userId) === tail) locks.delete(userId); });
    return run;
  };

  ctx.money = createMoney(db);
  ctx.hub = createHub(ctx);
  ctx.analysisPool = opts.analysisPool || new EnginePool(config.analysisEngines, config.stockfishPath, { Threads: 1, Hash: 32 });
  ctx.games = createGames(ctx);
  ctx.matchmaker = createMatchmaker(ctx);
  ctx.wallet = createWallet(ctx);
  ctx.enforcement = createEnforcement(ctx);
  ctx.fairplay = new FairPlay({ db, pool: ctx.analysisPool, nodes: opts.analysisNodes || config.analysisNodes, enforce: ctx.enforcement });

  const recovered = await ctx.games.recover();
  await ctx.wallet.resumePending();
  await ctx.enforcement.tick();

  // ---- site on/off ----
  // Admins can make the site unavailable to players. The switch lives in
  // the database so a restart or redeploy keeps it where it was.
  const settings = db.raw.collection('settings');
  ctx.site = { maintenance: !!(await settings.findOne({ _id: 'site' }))?.maintenance };
  // Turning it on empties the queues and voids live games (both stakes go
  // back), then sends every player's open tab to the notice.
  ctx.setMaintenance = async (on) => {
    await settings.updateOne({ _id: 'site' }, { $set: { maintenance: on, changed_at: Date.now() } }, { upsert: true });
    ctx.site.maintenance = on;
    if (!on) return { maintenance: false };
    const queued = await ctx.matchmaker.leaveAll('site-offline');
    const games = [...ctx.games.live.values()].filter((g) => g.status === 'active');
    await Promise.all(games.map((g) => g.end({ status: 'aborted', reason: 'site-offline' })));
    ctx.hub.sendPlayersAway();
    return { maintenance: true, queued, games: games.length };
  };

  // ---- auth helpers ----
  // Session tokens are looked up once a minute at most; the user record is
  // read fresh on every request so balance and status are always current.
  const sessionCache = new Map();
  async function userFromToken(token) {
    if (!token) return null;
    const h = sha(token);
    let s = sessionCache.get(h);
    if (!s || Date.now() - s.at > 60_000) {
      const row = await db.sessions.findOne({ _id: h }, { projection: { user_id: 1, expires_at: 1 } });
      s = { userId: row?.user_id ?? null, expires: row?.expires_at ?? 0, at: Date.now() };
      if (sessionCache.size > 10_000) sessionCache.clear();
      sessionCache.set(h, s);
    }
    if (!s.userId || s.expires < Date.now()) return null;
    return db.users.findOne({ _id: s.userId });
  }

  const gameRowFields = { moves: 1, fen: 1, kind: 1, tc: 1, stake: 1, status: 1, result: 1, reason: 1, white_id: 1, black_id: 1, white_name: 1, black_name: 1, rake: 1, payout_white: 1, payout_black: 1, created_at: 1, ended_at: 1 };

  const api = (ctx.api = {
    async authFromRequest(req) {
      const c = parseCookies(req.headers.cookie);
      return { user: await userFromToken(c.cbs), device: /^[a-f0-9]{32}$/.test(c.cbd || '') ? c.cbd : null, ip: clientIp(req) };
    },
    sameOrigin(origin, host) {
      try { return new URL(origin).host === host; } catch { return false; }
    },
    async hello(userId) {
      const base = { t: 'hello', queues: ctx.matchmaker.counts(), online: ctx.hub.online() };
      if (!userId) return { ...base, user: null };
      const u = await db.users.findOne({ _id: userId });
      const g = ctx.games.activeFor(userId);
      return { ...base, user: await publicUser(u), queue: ctx.matchmaker.status(userId), activeGame: g ? g.id : null };
    },
    async gameRow(id, viewerId) {
      const r = await db.games.findOne({ _id: id }, { projection: gameRowFields });
      if (!r || r.status === 'active') return null;
      const moves = r.moves || [];
      const side = (c) => {
        const uid = c === 'w' ? r.white_id : r.black_id;
        return { userId: uid, name: c === 'w' ? r.white_name : r.black_name };
      };
      const you = viewerId && r.white_id === viewerId ? 'w' : viewerId && r.black_id === viewerId ? 'b' : null;
      return {
        id: r.id, kind: r.kind, tc: r.tc, stake: r.stake,
        payouts: humanPayouts(r.stake),
        white: side('w'), black: side('b'), you,
        fen: r.fen, moves: moves.map((m) => ({ u: m.u, s: m.s })),
        clocks: { w: moves.filter((_, i) => i % 2 === 0).at(-1)?.c ?? r.tc * 60_000, b: moves.filter((_, i) => i % 2 === 1).at(-1)?.c ?? r.tc * 60_000 },
        running: false, turn: moves.length % 2 ? 'b' : 'w', status: r.status, result: r.result, reason: r.reason,
        settlement: { rake: r.rake, w: r.payout_white, b: r.payout_black }, chat: [], gone: {}, serverNow: Date.now(),
        createdAt: r.created_at, endedAt: r.ended_at,
      };
    },
  });

  async function publicUser(u) {
    if (!u) return null;
    return {
      id: u.id, username: u.username, balance: u.balance, held: await ctx.money.heldTotal(u.id),
      status: u.status, suspendedAt: u.suspended_at, isAdmin: !!u.is_admin, createdAt: u.created_at, bonus: u.bonus ?? null,
    };
  }
  const freshUser = async (id) => publicUser(await db.users.findOne({ _id: id }));

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
    next();
  });

  // Site switched off from Admin: players get the unavailable notice and
  // every API call is refused. Admins pass, and /login stays open so they
  // can sign in. Static files (anything with an extension) are served.
  const OPEN_WHILE_OFF = new Set(['GET /api/config', 'GET /api/me', 'POST /api/login', 'POST /api/logout']);
  app.use(async (req, res, next) => {
    if (!ctx.site.maintenance) return next();
    const isApi = req.path.startsWith('/api');
    if (isApi ? OPEN_WHILE_OFF.has(`${req.method} ${req.path}`) : req.path === '/login' || /\.\w+$/.test(req.path)) return next();
    let user = null;
    try { user = await userFromToken(req.cookies.cbs); } catch {}
    if (user?.is_admin) return next();
    res.status(503).set('Retry-After', '600');
    if (isApi) return res.json({ error: 'ChessBets is unavailable right now.', code: 'maintenance' });
    res.type('html').send(MAINTENANCE_PAGE);
  });

  // Only API calls need the signed-in user; static files skip the lookup.
  app.use('/api', async (req, res, next) => {
    try { req.user = await userFromToken(req.cookies.cbs); }
    catch (e) { console.error('session lookup', e.message); return res.status(503).json({ error: 'Service unavailable, try again shortly' }); }
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

  async function startSession(res, user, req) {
    const token = crypto.randomBytes(32).toString('base64url');
    const t = Date.now();
    const expires = t + config.sessionDays * 86_400_000;
    await db.sessions.insert({
      _id: sha(token), user_id: user.id, created_at: t, expires_at: expires, expire_at: new Date(expires),
      ip: req.ip2, ua: String(req.get('user-agent') || '').slice(0, 200),
    });
    await db.users.update({ _id: user.id }, { $set: { last_ip: req.ip2, last_seen: t } });
    await ctx.enforcement.seenDevice(user.id, req.device, req.ip2);
    res.append('Set-Cookie', `cbs=${token}; Path=/; Max-Age=${config.sessionDays * 86400}; HttpOnly; SameSite=Lax${config.prod ? '; Secure' : ''}`);
  }

  const authLimit = limiter(config.loginPerMinute, 60_000);
  // Wrong passwords per account, from any IP, so a password can't be
  // guessed by spreading attempts over many addresses. Too many locks that
  // account's sign-in until the 15-minute window passes.
  const FAIL_WINDOW = 15 * 60_000;
  const failed = new Map(); // username_lc -> { at, n }
  const lockedOut = (name) => {
    const f = failed.get(name);
    return !!f && Date.now() - f.at < FAIL_WINDOW && f.n >= config.loginFailsPerAccount;
  };
  function noteFailure(name) {
    const t = Date.now();
    if (failed.size > 20_000) for (const [k, f] of failed) if (t - f.at > FAIL_WINDOW) failed.delete(k);
    const f = failed.get(name);
    if (!f || t - f.at > FAIL_WINDOW) failed.set(name, { at: t, n: 1 });
    else f.n++;
  }
  const registerLimit = limiter(config.registerPerHour, 3600_000);

  app.post('/api/register', wrap(async (req, res) => {
    if (!registerLimit(req.ip2)) return res.status(429).json({ error: 'Too many sign-ups from this network. Try later.' });
    const { username, password, adult, terms } = req.body || {};
    const name = String(username || '').trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return res.status(400).json({ error: 'Username must be 3 to 16 letters, numbers or underscores', field: 'username' });
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be at least 8 characters', field: 'password' });
    if (adult !== true || terms !== true) return res.status(400).json({ error: 'Confirm you are 21 or older and accept the terms', field: 'terms' });
    const taken = { error: 'That username is taken', field: 'username' };
    if (await db.users.findOne({ username_lc: name.toLowerCase() }, { projection: { _id: 1 } })) return res.status(409).json(taken);
    const id = await db.nextId('users');
    const doc = {
      _id: id, username: name, username_lc: name.toLowerCase(), pass_hash: hashPassword(password), balance: 0,
      status: 'active', suspended_at: null, suspend_reason: null, forfeited: 0, review: 0,
      is_admin: 0, // admins are made with `npm run make-admin`, never by signing up
      created_at: Date.now(), created_ip: req.ip2, device_id: req.device, last_ip: null, last_seen: null,
      bonus: config.signupBonus > 0 ? 'pending' : null, // sign-up bonus, paid by wallet.signupBonus
    };
    try { await db.users.insert(doc); }
    catch (e) { if (e.code === 11000) return res.status(409).json(taken); throw e; }
    const user = await db.users.findOne({ _id: id });
    await startSession(res, user, req);
    res.json({ user: await publicUser(user) });
  }));

  app.post('/api/login', wrap(async (req, res) => {
    if (!authLimit(req.ip2)) return res.status(429).json({ error: 'Too many attempts. Wait a minute.' });
    const { username, password } = req.body || {};
    const name = String(username || '').trim().toLowerCase().slice(0, 32);
    if (lockedOut(name)) return res.status(429).json({ error: 'Too many wrong passwords for this account. Try again in 15 minutes.' });
    const user = await db.users.findOne({ username_lc: name });
    if (!user || typeof password !== 'string' || !checkPassword(password, user.pass_hash)) {
      noteFailure(name);
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    failed.delete(name);
    await startSession(res, user, req);
    res.json({ user: await publicUser(user) });
  }));

  app.post('/api/logout', wrap(async (req, res) => {
    if (req.cookies.cbs) {
      sessionCache.delete(sha(req.cookies.cbs));
      await db.sessions.delete({ _id: sha(req.cookies.cbs) });
    }
    res.append('Set-Cookie', 'cbs=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    res.json({ ok: true });
  }));

  app.get('/api/me', wrap(async (req, res) => {
    const g = req.user ? ctx.games.activeFor(req.user.id) : null;
    res.json({ user: await publicUser(req.user), activeGame: g?.id || null, queue: req.user ? ctx.matchmaker.status(req.user.id) : null });
  }));

  // Every page load fetches /api/config, so this is where a visit is
  // counted: one per browser (device cookie) per UTC day. Crawlers that
  // don't run scripts never get here, and admins aren't counted.
  const visitsSeen = new Set();
  function countVisit(req) {
    if (!req.device || req.user?.is_admin) return;
    const day = new Date().toISOString().slice(0, 10);
    const key = `${day}:${req.device}`;
    if (visitsSeen.has(key)) return;
    if (visitsSeen.size > 50_000) visitsSeen.clear();
    visitsSeen.add(key);
    db.visits.update({ _id: key }, { $setOnInsert: { day, device: req.device, user_id: req.user?.id ?? null, at: new Date() } }, { upsert: true })
      .catch((e) => console.error('visit', e.message));
  }

  app.get('/api/config', (req, res) => {
    countVisit(req);
    res.json({
      queues: config.timeControls.flatMap((tc) => config.stakes.map((stake) => ({ key: `${tc}:${stake}`, tc, stake, ...humanPayouts(stake) }))),
      rakeBps: config.rakeBps,
      withdrawFeeBps: config.withdrawFeeBps,
      minWithdraw: config.minWithdraw,
      coins: ctx.wallet.coins(),
      payments: config.payments,
      chat: CHAT_PRESETS,
      counts: ctx.matchmaker.counts(),
      maintenance: ctx.site.maintenance,
      signupBonus: config.signupBonus > 0 ? { amount: config.signupBonus, minDeposit: config.signupBonusMinDeposit } : null,
    });
  });

  // ---- games ----
  app.get('/api/games/:id', wrap(async (req, res) => {
    const g = ctx.games.get(req.params.id);
    if (g) {
      const color = req.user ? g.colorOf(req.user.id) : null;
      if (g.status === 'active' && !color) return res.status(403).json({ error: 'Live games are private to the two players' });
      return res.json({ game: g.snapshot(req.user?.id) });
    }
    const row = await api.gameRow(req.params.id, req.user?.id);
    if (!row) return res.status(404).json({ error: 'Game not found' });
    res.json({ game: row });
  }));

  app.get('/api/my/games', needUser, wrap(async (req, res) => {
    const me = req.user.id;
    const rows = await db.games.find(
      { $or: [{ white_id: me }, { black_id: me }], status: { $ne: 'active' } },
      { projection: { moves: 0, fen: 0 }, sort: { created_at: -1 }, limit: 100 },
    );
    res.json({
      games: rows.map((r) => {
        const color = r.white_id === me ? 'w' : 'b';
        const opp = color === 'w' ? r.black_name : r.white_name;
        const payout = color === 'w' ? r.payout_white : r.payout_black;
        const outcome = r.status === 'aborted' ? 'aborted' : r.result === '1/2-1/2' ? 'draw' : (r.result === '1-0') === (color === 'w') ? 'win' : 'loss';
        return { id: r.id, kind: r.kind, tc: r.tc, stake: r.stake, color, opponent: opp, outcome, reason: r.reason, payout, plies: r.ply ?? 0, at: r.ended_at || r.created_at };
      }),
    });
  }));

  app.get('/api/feed', wrap(async (req, res) => {
    const filter = { kind: 'human', status: 'finished', ...(req.query.f === 'high' ? { stake: { $gte: 1000 } } : {}) };
    const rows = await db.games.find(filter, { projection: { moves: 0, fen: 0 }, sort: { ended_at: -1 }, limit: 20 });
    res.json({ rows: rows.flatMap(feedShape).slice(0, 20) });
  }));

  app.get('/api/stats', wrap(async (req, res) => {
    const recent = { kind: 'human', status: 'finished', ended_at: { $gt: Date.now() - 86_400_000 } };
    const [games24h, wagered24h] = await Promise.all([
      db.games.count(recent),
      db.games.sum({ $multiply: ['$stake', 2] }, recent),
    ]);
    const stats = {
      online: ctx.hub.online(),
      playing: [...ctx.games.live.values()].filter((g) => g.status === 'active').length,
      games24h,
      wagered24h,
    };
    // Numbers below their minimum go out as null and the lobby leaves them out.
    for (const k of Object.keys(stats)) if (stats[k] < (config.statsMin[k] ?? 0)) stats[k] = null;
    res.json(stats);
  }));

  // ---- wallet ----
  app.get('/api/wallet', needUser, wrap(async (req, res) => {
    res.json({
      ...(await ctx.wallet.overview(req.user.id)), user: await publicUser(req.user), coins: ctx.wallet.coins(), payments: config.payments,
      feeBps: config.withdrawFeeBps, minWithdraw: config.minWithdraw, minDeposit: config.cryptoMinDeposit, maxDeposit: config.cryptoMaxDeposit,
    });
  }));
  // "Check for my payment": scans this player's addresses now (at most
  // every 10 seconds) instead of waiting for the next sweep.
  app.post('/api/wallet/refresh', needUser, wrap(async (req, res) => {
    try { await ctx.wallet.refresh(req.user.id); } catch (e) { console.error('wallet refresh', e.message); }
    res.json({ ...(await ctx.wallet.overview(req.user.id)), user: await freshUser(req.user.id) });
  }));
  app.get('/api/wallet/deposits/:id', needUser, wrap(async (req, res) => {
    res.json({ deposit: await ctx.wallet.invoice(req.user.id, Number(req.params.id)) });
  }));
  app.post('/api/wallet/address', needUser, needActive, wrap(async (req, res) => {
    res.json(await ctx.wallet.address(req.user.id, String(req.body?.coin || '')));
  }));
  app.post('/api/wallet/deposit', needUser, needActive, wrap(async (req, res) => {
    const amount = Math.round(Number(req.body?.amount));
    res.json({ deposit: await ctx.wallet.deposit(req.user, String(req.body?.coin || ''), amount) });
  }));
  app.post('/api/wallet/withdraw', needUser, needActive, wrap(async (req, res) => {
    const amount = Math.round(Number(req.body?.amount));
    const w = await ctx.wallet.withdraw(req.user, String(req.body?.coin || ''), req.body?.address, amount);
    res.json({ withdrawal: w, user: await freshUser(req.user.id) });
  }));

  // ---- support ----
  const ticketOut = ({ messages, ...t }) => ({ ...t, messages: messages || [] });
  app.get('/api/tickets', needUser, wrap(async (req, res) => {
    const tickets = await db.tickets.find({ user_id: req.user.id }, { sort: { updated_at: -1 } });
    res.json({ tickets: tickets.map(ticketOut) });
  }));
  app.post('/api/tickets', needUser, wrap(async (req, res) => {
    const subject = String(req.body?.subject || '').trim().slice(0, 120);
    const body = String(req.body?.body || '').trim().slice(0, 4000);
    if (subject.length < 3 || body.length < 10) return res.status(400).json({ error: 'Add a subject and a few words about the problem' });
    const open = await db.tickets.count({ user_id: req.user.id, status: 'open' });
    if (open >= 5) return res.status(429).json({ error: 'You already have 5 open tickets' });
    const t = Date.now();
    const id = await db.nextId('tickets');
    await db.tickets.insert({ _id: id, user_id: req.user.id, subject, status: 'open', created_at: t, updated_at: t, messages: [{ author: 'user', body, created_at: t }] });
    res.json({ id });
  }));
  app.post('/api/tickets/:id/reply', needUser, wrap(async (req, res) => {
    const body = String(req.body?.body || '').trim().slice(0, 4000);
    if (!body) return res.status(400).json({ error: 'Write a message' });
    const t = Date.now();
    const r = await db.tickets.update(
      { _id: Number(req.params.id), user_id: req.user.id },
      { $push: { messages: { author: 'user', body, created_at: t } }, $set: { status: 'open', updated_at: t } },
    );
    if (!r.matchedCount) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ ok: true });
  }));

  // ---- admin ----
  app.get('/api/admin/overview', needUser, needAdmin, wrap(async (req, res) => {
    const house = (await db.ledger.aggregate([
      { $match: { user_id: null } },
      { $group: { _id: '$kind', total: { $sum: '$amount' }, n: { $sum: 1 } } },
    ])).map((h) => ({ kind: h._id, total: h.total, n: h.n }));

    const flagged = await db.users.find(
      { $or: [{ review: 1 }, { status: 'suspended' }] },
      { projection: { username: 1, status: 1, review: 1, balance: 1, suspend_reason: 1 }, sort: { _id: -1 }, limit: 100 },
    );
    const ids = flagged.map((u) => u.id);
    const [maxEv, evCount] = await Promise.all([
      db.fair_play_reports.aggregate([{ $match: { user_id: { $in: ids } } }, { $group: { _id: '$user_id', m: { $max: '$evidence' } } }]),
      db.fair_play_events.aggregate([{ $match: { user_id: { $in: ids } } }, { $group: { _id: '$user_id', n: { $sum: 1 } } }]),
    ]);
    const maxBy = new Map(maxEv.map((r) => [r._id, r.m]));
    const evBy = new Map(evCount.map((r) => [r._id, r.n]));
    for (const u of flagged) { u.maxEvidence = maxBy.get(u.id) ?? null; u.events = evBy.get(u.id) || 0; }

    const pending = await db.scheduled_actions.find({ status: 'pending' }, { sort: { run_at: 1 } });
    const names = new Map((await db.users.find({ _id: { $in: pending.map((a) => a.user_id) } }, { projection: { username: 1 } })).map((u) => [u.id, u.username]));
    for (const a of pending) a.username = names.get(a.user_id) || null;

    const dayAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const [users, balances, held, games, openTickets, visitorsToday, visitorsYesterday, visitors7d] = await Promise.all([
      db.users.count(),
      db.users.sum('$balance'),
      db.holds.sum('$amount', { status: 'held' }),
      db.games.count({ status: 'finished' }),
      db.tickets.count({ status: 'open' }),
      db.visits.count({ day: dayAgo(0) }),
      db.visits.count({ day: dayAgo(1) }),
      db.visits.aggregate([{ $match: { day: { $gte: dayAgo(6) } } }, { $group: { _id: '$device' } }, { $count: 'n' }]).then((r) => r[0]?.n ?? 0),
    ]);
    const unsettled = await db.games.find({ status: 'unsettled' }, { projection: { white_name: 1, black_name: 1, stake: 1, result: 1, final_status: 1, ended_at: 1 }, sort: { ended_at: 1 }, limit: 100 });
    const refunds = await db.refunds.find({ status: 'pending' }, { sort: { created_at: 1 }, limit: 200 });
    const who = new Map((await db.users.find({ _id: { $in: [...new Set(refunds.flatMap((r) => [r.user_id, r.cheater_id]))] } }, { projection: { username: 1 } })).map((u) => [u.id, u.username]));
    for (const r of refunds) { r.username = who.get(r.user_id) || null; r.cheater = who.get(r.cheater_id) || null; }
    res.json({ house, flagged, pending, refunds, unsettled, maintenance: ctx.site.maintenance, totals: { users, balances, held, games, openTickets }, visitors: { today: visitorsToday, yesterday: visitorsYesterday, week: visitors7d }, model: MODEL });
  }));
  app.post('/api/admin/maintenance', needUser, needAdmin, wrap(async (req, res) => {
    res.json(await ctx.setMaintenance(req.body?.on === true));
  }));
  // Every account (newest first), with what each has deposited and withdrawn.
  // ?q= narrows it to usernames containing the text.
  app.get('/api/admin/users', needUser, needAdmin, wrap(async (req, res) => {
    const q = String(req.query.q || '').toLowerCase().slice(0, 32);
    const users = await db.users.find(
      q ? { username_lc: { $regex: escapeRegex(q) } } : {},
      { projection: { username: 1, balance: 1, status: 1, review: 1, is_admin: 1, bonus: 1, created_at: 1, last_seen: 1, last_ip: 1 }, sort: { _id: -1 }, limit: 5000 },
    );
    const flows = await db.ledger.aggregate([
      { $match: { user_id: { $in: users.map((u) => u.id) }, kind: { $in: ['deposit', 'withdrawal', 'withdrawal_refund'] } } },
      { $group: { _id: { u: '$user_id', k: '$kind' }, total: { $sum: '$amount' } } },
    ]);
    const sum = (id, k) => flows.find((f) => f._id.u === id && f._id.k === k)?.total || 0;
    res.json({
      users: users.map((u) => ({
        ...u, isAdmin: !!u.is_admin, deposited: sum(u.id, 'deposit'),
        withdrawn: -(sum(u.id, 'withdrawal') + sum(u.id, 'withdrawal_refund')),
      })),
    });
  }));
  app.get('/api/admin/users/:id', needUser, needAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const u = await db.users.findOne({ _id: id }, { projection: { username: 1, balance: 1, status: 1, review: 1, forfeited: 1, suspend_reason: 1, suspended_at: 1, created_at: 1, created_ip: 1, last_ip: 1 } });
    if (!u) return res.status(404).json({ error: 'No such user' });
    const [reports, events, devices, ledger, pendingActions] = await Promise.all([
      db.fair_play_reports.find({ user_id: id }, { projection: { _id: 0, game_id: 1, evidence: 1, verdict: 1, metrics: 1, created_at: 1 }, sort: { created_at: -1 }, limit: 30 }),
      db.fair_play_events.find({ user_id: id }, { projection: { _id: 0, game_id: 1, kind: 1, detail: 1, created_at: 1 }, sort: { _id: -1 }, limit: 100 }),
      db.user_devices.find({ user_id: id }, { projection: { _id: 0, device_id: 1, ip: 1, last_seen: 1 } }),
      db.ledger.find({ user_id: id }, { projection: { _id: 0, kind: 1, amount: 1, balance_after: 1, ref: 1, note: 1, created_at: 1 }, sort: { _id: -1 }, limit: 50 }),
      db.scheduled_actions.find({ user_id: id, status: 'pending' }),
    ]);
    // Other accounts seen on each of this user's browsers.
    const others = await db.user_devices.find({ device_id: { $in: devices.map((d) => d.device_id) }, user_id: { $ne: id } }, { projection: { device_id: 1, user_id: 1 } });
    const otherNames = new Map((await db.users.find({ _id: { $in: [...new Set(others.map((o) => o.user_id))] } }, { projection: { username: 1 } })).map((x) => [x.id, x.username]));
    for (const d of devices) {
      const list = others.filter((o) => o.device_id === d.device_id).map((o) => otherNames.get(o.user_id)).filter(Boolean);
      d.shared = list.length ? list.join(',') : null;
    }
    res.json({
      user: u,
      account: accountEvidence(reports.slice(0, MODEL.historyGames).map((r) => r.metrics)),
      reports,
      events,
      devices,
      ledger,
      pending: pendingActions,
    });
  }));
  app.post('/api/admin/users/:id/suspend', needUser, needAdmin, wrap(async (req, res) => {
    const reason = String(req.body?.reason || 'Suspended by staff').slice(0, 300);
    res.json({ ok: await ctx.enforcement.suspend(Number(req.params.id), reason, null, { refund: req.body?.refund !== false }) });
  }));
  app.post('/api/admin/users/:id/reinstate', needUser, needAdmin, wrap(async (req, res) => {
    res.json({ ok: await ctx.enforcement.reinstate(Number(req.params.id), { restore: !!req.body?.restore }) });
  }));
  app.post('/api/admin/users/:id/clear-review', needUser, needAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    await db.scheduled_actions.updateMany({ user_id: id, status: 'pending' }, { $set: { status: 'cancelled', done_at: Date.now() } });
    await ctx.enforcement.clearReview(id);
    res.json({ ok: true });
  }));
  app.post('/api/admin/refunds/:id/:decision', needUser, needAdmin, wrap(async (req, res) => {
    const { decision } = req.params;
    if (decision !== 'approve' && decision !== 'decline') return res.status(404).json({ error: 'Not found' });
    const note = String(req.body?.note || '').trim().slice(0, 200) || null;
    const r = await ctx.enforcement.decideRefund(Number(req.params.id), decision === 'approve', req.user.id, note);
    if (!r) return res.status(409).json({ error: 'This refund was already decided' });
    res.json({ ok: true });
  }));
  app.get('/api/admin/payments', needUser, needAdmin, wrap(async (req, res) => {
    res.json(await ctx.wallet.staffView());
  }));
  app.post('/api/admin/withdrawals/:id/sent', needUser, needAdmin, wrap(async (req, res) => {
    const txid = String(req.body?.txid || '').trim();
    if (!/^[A-Za-z0-9]{8,128}$/.test(txid)) return res.status(400).json({ error: 'Paste the transaction id of the payment you sent' });
    if (!(await ctx.wallet.completeWithdraw(Number(req.params.id), txid))) return res.status(409).json({ error: 'This withdrawal is no longer open' });
    res.json({ ok: true });
  }));
  app.post('/api/admin/withdrawals/:id/reject', needUser, needAdmin, wrap(async (req, res) => {
    const note = String(req.body?.note || '').trim().slice(0, 200);
    if (!(await ctx.wallet.rejectWithdraw(Number(req.params.id), note))) return res.status(409).json({ error: 'This withdrawal is no longer open' });
    res.json({ ok: true });
  }));
  app.post('/api/admin/users/:id/credit', needUser, needAdmin, wrap(async (req, res) => {
    const amount = Math.round(Number(req.body?.amount));
    const note = String(req.body?.note || '').trim().slice(0, 200);
    res.json({ deposit: await ctx.wallet.manualCredit(Number(req.params.id), amount, req.body?.txid, String(req.body?.coin || '').slice(0, 16) || null, note) });
  }));
  app.get('/api/admin/tickets', needUser, needAdmin, wrap(async (req, res) => {
    const tickets = await db.tickets.aggregate([
      { $addFields: { open: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } } },
      { $sort: { open: -1, updated_at: -1 } },
      { $limit: 100 },
      { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'u', pipeline: [{ $project: { username: 1, status: 1 } }] } },
    ]);
    res.json({
      tickets: tickets.map(({ _id, u, open, ...t }) => ticketOut({ id: _id, ...t, username: u[0]?.username ?? null, user_status: u[0]?.status ?? null })),
    });
  }));
  app.post('/api/admin/tickets/:id/reply', needUser, needAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const t = await db.tickets.findOne({ _id: id }, { projection: { user_id: 1 } });
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    const body = String(req.body?.body || '').trim().slice(0, 4000);
    const now = Date.now();
    await db.tickets.update({ _id: id }, {
      ...(body ? { $push: { messages: { author: 'staff', body, created_at: now } } } : {}),
      $set: { status: req.body?.close ? 'closed' : 'answered', updated_at: now },
    });
    ctx.hub.toUser(t.user_id, { t: 'notice', kind: 'ticket', id });
    res.json({ ok: true });
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ---- static ----
  app.get('/vendor/chess.js', (req, res) => {
    res.type('application/javascript').sendFile(path.join(ROOT, 'node_modules/chess.js/dist/esm/chess.js'));
  });
  app.use(express.static(path.join(ROOT, 'public'), { index: false, maxAge: config.prod ? '1h' : 0 }));
  // The house bots are gone; old links land on the lobby.
  app.get(/^\/bots(\/.*)?$/, (req, res) => res.redirect(301, '/'));
  app.get(/^\/(?!api|ws|vendor).*/, (req, res) => res.sendFile(path.join(ROOT, 'public/index.html')));

  const server = http.createServer(app);
  ctx.hub.attach(server);

  // `crash: true` stops everything without waiting for in-flight work, the
  // way a killed process would (used by the restart test).
  ctx.close = async ({ crash = false } = {}) => {
    ctx.closed = true;
    ctx.fairplay.closed = true;
    ctx.matchmaker.stop();
    ctx.enforcement.stop();
    ctx.wallet.stop();
    ctx.games.shutdown();
    ctx.hub.close?.();
    await new Promise((r) => server.close(() => r()));
    if (!opts.analysisPool) ctx.analysisPool.quit();
    if (!crash) {
      const deadline = Date.now() + 15_000;
      while (pending.size && Date.now() < deadline) await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 1000))]);
    }
    await db.close();
  };

  return { app, server, ctx, recovered };
}

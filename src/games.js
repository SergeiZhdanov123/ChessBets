import crypto from 'node:crypto';
import { Chess } from 'chess.js';
import { config } from './config.js';
import { humanPayouts } from './money.js';
import { BOTS, bookMove, thinkTime, drawingMoves } from './bots.js';
import { scoreCp } from './engine.js';

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const other = (c) => (c === 'w' ? 'b' : 'w');
const newId = () => crypto.randomBytes(6).toString('base64url');

// Can this side still deliver mate with what is left on the board?
function canMate(chess, color) {
  let minors = 0, knights = 0;
  for (const row of chess.board()) for (const sq of row) {
    if (!sq || sq.color !== color || sq.type === 'k') continue;
    if (sq.type === 'p' || sq.type === 'q' || sq.type === 'r') return true;
    minors++;
    if (sq.type === 'n') knights++;
  }
  return minors >= 2 && !(minors === 2 && knights === 2);
}

export class LiveGame {
  constructor(mgr, opts) {
    this.mgr = mgr;
    this.id = opts.id || newId();
    this.kind = opts.kind;
    this.tc = opts.tc;
    this.stake = opts.stake;
    this.white = opts.white; // { userId, username, holdId, ip, device } or { bot }
    this.black = opts.black;
    this.chess = new Chess();
    this.moves = [];
    this.clocks = { w: this.tc * 60_000, b: this.tc * 60_000 };
    this.status = 'active';
    this.createdAt = Date.now();
    this.turnStartedAt = Date.now();
    this.drawOffer = null;
    this.lastDrawOfferPly = { w: -99, b: -99 };
    this.timers = {};
    this.gone = {};
    this.chat = [];
    this.writes = Promise.resolve();
  }

  side(color) { return color === 'w' ? this.white : this.black; }
  colorOf(userId) {
    if (this.white.userId === userId) return 'w';
    if (this.black.userId === userId) return 'b';
    return null;
  }
  get turn() { return this.chess.turn(); }
  get ply() { return this.moves.length; }
  get clockRunning() { return this.status === 'active' && this.ply >= 2; }
  isBot(color) { return !!this.side(color).bot; }

  remaining(color, at = Date.now()) {
    if (this.clockRunning && this.turn === color) return Math.max(0, this.clocks[color] - (at - this.turnStartedAt));
    return this.clocks[color];
  }

  publicSide(color) {
    const s = this.side(color);
    if (s.bot) return { bot: s.bot, name: BOTS[s.bot].name, fullName: BOTS[s.bot].fullName };
    return { userId: s.userId, name: s.username };
  }

  snapshot(forUserId) {
    const now = Date.now();
    return {
      id: this.id,
      kind: this.kind,
      tc: this.tc,
      stake: this.stake,
      payouts: this.kind === 'human' ? humanPayouts(this.stake) : { win: this.stake * 2, draw: this.stake },
      white: this.publicSide('w'),
      black: this.publicSide('b'),
      you: forUserId ? this.colorOf(forUserId) : null,
      fen: this.chess.fen(),
      moves: this.moves.map((m) => ({ u: m.u, s: m.s })),
      clocks: { w: this.remaining('w', now), b: this.remaining('b', now) },
      running: this.clockRunning,
      turn: this.turn,
      status: this.status,
      result: this.result || null,
      reason: this.reason || null,
      drawOffer: this.drawOffer,
      firstMoveDeadline: this.firstMoveDeadline || null,
      gone: this.gone,
      chat: forUserId && this.colorOf(forUserId) ? this.chat.slice(-50) : [],
      settlement: this.settlement || null,
      serverNow: now,
    };
  }

  broadcast(msg) { this.mgr.hub.toGame(this.id, msg); }

  // Database writes for one game go out one at a time, in order.
  queue(job) {
    const p = this.writes.then(job);
    this.writes = p.catch((err) => { if (!this.mgr.closed) console.error('game write failed', this.id, err.message); });
    this.mgr.track(this.writes);
    return p;
  }

  start() {
    this.mgr.persistNew(this);
    this.armFirstMove();
    this.broadcast((c) => ({ t: 'game', game: this.snapshot(c.userId) }));
    if (this.isBot(this.turn)) this.mgr.scheduleBot(this);
  }

  armFirstMove() {
    clearTimeout(this.timers.abort);
    if (this.ply >= 2 || this.isBot(this.turn)) { this.firstMoveDeadline = null; return; }
    const ms = this.kind === 'bot' ? config.botFirstMoveMs : config.firstMoveMs;
    this.firstMoveDeadline = Date.now() + ms;
    this.timers.abort = setTimeout(() => this.end({ status: 'aborted', reason: 'no-first-move' }), ms);
  }

  armFlag() {
    clearTimeout(this.timers.flag);
    if (!this.clockRunning) return;
    const color = this.turn;
    this.timers.flag = setTimeout(() => this.checkFlag(), this.remaining(color) + 25);
  }

  checkFlag() {
    if (this.status !== 'active' || !this.clockRunning) return;
    const color = this.turn;
    if (this.remaining(color) > 0) return this.armFlag();
    this.clocks[color] = 0;
    // Running out of time is a loss unless the other side cannot possibly mate.
    if (!canMate(this.chess, other(color))) this.end({ result: '1/2-1/2', reason: 'timeout-draw' });
    else this.end({ result: color === 'w' ? '0-1' : '1-0', reason: 'timeout' });
  }

  // Returns an error string, or null when the move was played.
  move(color, uci, info = {}) {
    if (this.status !== 'active') return 'Game is over';
    if (color !== this.turn) return 'Not your turn';
    if (typeof uci !== 'string' || !UCI.test(uci)) return 'Bad move';
    if (info.ply !== undefined && info.ply !== this.ply) return 'Out of sync';
    const now = Date.now();
    const think = now - this.turnStartedAt;
    if (this.clockRunning) {
      const lagComp = Math.min(info.lagComp || 0, 300);
      const spent = Math.max(0, think - lagComp);
      if (spent >= this.clocks[color]) { this.checkFlag(); return 'Time is up'; }
      this.clocks[color] -= spent;
    }
    let mv;
    try {
      mv = this.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
    } catch {
      return 'Illegal move';
    }
    const rec = { u: mv.from + mv.to + (mv.promotion || ''), s: mv.san, t: think, c: this.clocks[color] };
    if (info.blur) rec.b = Math.min(99, info.blur | 0);
    if (info.hidden) rec.h = Math.min(3_600_000, info.hidden | 0);
    this.moves.push(rec);
    this.turnStartedAt = now;
    if (this.drawOffer && this.drawOffer !== color) this.drawOffer = null; // replying with a move declines
    this.mgr.persistMoves(this);
    this.armFirstMove();
    this.broadcast({
      t: 'move', id: this.id, u: rec.u, s: rec.s, ply: this.ply, fen: this.chess.fen(),
      clocks: { w: this.clocks.w, b: this.clocks.b }, running: this.clockRunning, drawOffer: this.drawOffer,
      firstMoveDeadline: this.firstMoveDeadline || null, serverNow: now,
    });
    this.mgr.fairplay?.onMove(this);

    if (this.chess.isCheckmate()) return this.end({ result: color === 'w' ? '1-0' : '0-1', reason: 'checkmate' }), null;
    if (this.chess.isStalemate()) return this.end({ result: '1/2-1/2', reason: 'stalemate' }), null;
    if (this.chess.isInsufficientMaterial()) return this.end({ result: '1/2-1/2', reason: 'insufficient' }), null;
    if (this.chess.isThreefoldRepetition()) return this.end({ result: '1/2-1/2', reason: 'repetition' }), null;
    if (this.chess.isDraw()) return this.end({ result: '1/2-1/2', reason: 'fifty-moves' }), null;

    this.armFlag();
    if (this.isBot(this.turn)) this.mgr.scheduleBot(this);
    return null;
  }

  resign(color) {
    if (this.status !== 'active') return;
    if (this.ply < 2) return this.abort(color);
    this.end({ result: color === 'w' ? '0-1' : '1-0', reason: 'resign' });
  }

  abort(color) {
    if (this.status !== 'active' || this.ply >= 2) return 'Too late to abort';
    this.end({ status: 'aborted', reason: 'aborted', by: color });
    return null;
  }

  offerDraw(color) {
    if (this.status !== 'active' || this.ply < 2) return 'Not now';
    if (this.kind === 'bot') return 'Bots play every game to the end';
    if (this.drawOffer === other(color)) return this.acceptDraw(color);
    if (this.ply - this.lastDrawOfferPly[color] < 6) return 'You offered a draw recently';
    this.drawOffer = color;
    this.lastDrawOfferPly[color] = this.ply;
    this.broadcast({ t: 'draw', id: this.id, offer: color });
    return null;
  }

  acceptDraw(color) {
    if (this.status !== 'active' || this.drawOffer !== other(color)) return 'No draw offer';
    this.end({ result: '1/2-1/2', reason: 'agreement' });
    return null;
  }

  declineDraw(color) {
    if (this.drawOffer === other(color)) {
      this.drawOffer = null;
      this.broadcast({ t: 'draw', id: this.id, offer: null });
    }
  }

  presence(color, connected) {
    if (this.status !== 'active' || this.isBot(color)) return;
    clearTimeout(this.timers['gone' + color]);
    if (connected) {
      if (this.gone[color]) { delete this.gone[color]; this.broadcast({ t: 'presence', id: this.id, gone: this.gone }); }
      return;
    }
    const ms = config.abandonMs[this.tc] ?? 60_000;
    this.gone[color] = Date.now() + ms;
    this.broadcast({ t: 'presence', id: this.id, gone: this.gone });
    this.timers['gone' + color] = setTimeout(() => {
      if (this.status !== 'active' || !this.gone[color]) return;
      if (this.ply < 2) this.end({ status: 'aborted', reason: 'abandoned-early' });
      else this.end({ result: color === 'w' ? '0-1' : '1-0', reason: 'abandoned' });
    }, ms);
  }

  addChat(color, text) {
    const entry = { c: color, text, at: Date.now() };
    this.chat.push(entry);
    // Only the two players see the chat.
    this.broadcast((c) => (c.userId && this.colorOf(c.userId) ? { t: 'chat', id: this.id, entry } : null));
  }

  // { result, reason } for a finished game, { status: 'aborted' } for no game.
  // The game stops at once; the returned promise settles once the money has
  // moved and both players have been told.
  end({ result = null, reason, status = 'finished', fairplay = null }) {
    if (this.status !== 'active' || this.mgr.closed) return this.ended || Promise.resolve();
    this.status = status;
    this.result = result;
    this.reason = reason;
    for (const t of Object.values(this.timers)) clearTimeout(t);
    const now = Date.now();
    this.endedAt = now;
    if (this.ply >= 2) this.clocks[this.turn] = Math.max(0, this.clocks[this.turn] - (now - this.turnStartedAt));
    this.ended = this.mgr.finish(this, fairplay);
    return this.ended;
  }
}

export function createGames(ctx) {
  const { db, money, hub } = ctx;
  const live = new Map();
  const byUser = new Map(); // userId -> gameId

  const mgr = {
    hub,
    live,
    track: (p) => ctx.track(p),
    get closed() { return !!ctx.closed; },
    get fairplay() { return ctx.fairplay; },

    activeFor: (userId) => {
      const id = byUser.get(userId);
      const g = id && live.get(id);
      return g && g.status === 'active' ? g : null;
    },
    get: (id) => live.get(id),

    createHuman(a, b) {
      const [white, black] = Math.random() < 0.5 ? [a, b] : [b, a];
      const g = new LiveGame(mgr, { kind: 'human', tc: a.tc, stake: a.stake, white, black });
      g.queue(() => money.moveHolds([white.holdId, black.holdId], 'game', `game:${g.id}`));
      live.set(g.id, g);
      byUser.set(white.userId, g.id);
      byUser.set(black.userId, g.id);
      g.start();
      return g;
    },

    async createBot(user, botId, stake, colorPref, net = {}) {
      if (!BOTS[botId]) throw Object.assign(new Error('Unknown bot'), { status: 400 });
      // Right after a restart the engine may still be starting; give it a moment.
      if (!ctx.botPool.healthy && !(await ctx.botPool.whenReady?.(8000))) throw Object.assign(new Error('The bots are offline for a moment. Try again shortly.'), { status: 503 });
      const color = colorPref === 'w' || colorPref === 'b' ? colorPref : Math.random() < 0.5 ? 'w' : 'b';
      const id = newId();
      const holdId = await money.hold(user.id, stake, 'game', `game:${id}`);
      const human = { userId: user.id, username: user.username, holdId, ip: net.ip, device: net.device };
      const bot = { bot: botId };
      const g = new LiveGame(mgr, { id, kind: 'bot', tc: config.botMinutes, stake, white: color === 'w' ? human : bot, black: color === 'b' ? human : bot });
      live.set(g.id, g);
      byUser.set(user.id, g.id);
      g.start();
      return g;
    },

    // Money moves for a finished or aborted game, and the final game record,
    // in one transaction.
    async finish(g, fairplay) {
      try {
        g.settlement = await g.queue(() => db.tx(async () => {
          const out = await mgr.settle(g, fairplay);
          await db.games.replace({ _id: g.id }, mgr.doc(g, out), { upsert: true });
          return out;
        }));
      } catch (err) {
        console.error('settlement failed', g.id, err.message);
        g.settlement = null;
      }
      g.broadcast((c) => ({ t: 'end', id: g.id, game: g.snapshot(c.userId) }));
      await mgr.onEnded(g);
    },

    async settle(g, fairplay) {
      const ref = `game:${g.id}`;
      const seats = ['w', 'b'].map((c) => ({ c, ...g.side(c) })).filter((s) => s.userId);
      const out = { rake: 0, w: 0, b: 0 };
      if (g.status === 'aborted') {
        for (const s of seats) out[s.c] = await money.release(s.holdId, 'stake_return');
        return out;
      }
      for (const s of seats) await money.consume(s.holdId);
      const winner = g.result === '1-0' ? 'w' : g.result === '0-1' ? 'b' : null;

      if (g.kind === 'bot') {
        const s = seats[0];
        if (winner === s.c) {
          out[s.c] = g.stake * 2;
          await money.userEntry(s.userId, g.stake * 2, 'win', ref);
          await money.house(-g.stake, 'bot_loss', ref);
        } else if (!winner) {
          out[s.c] = g.stake;
          await money.userEntry(s.userId, g.stake, 'stake_return', ref, 'Draw');
        } else {
          await money.house(g.stake, 'bot_win', ref);
        }
        return out;
      }

      const p = humanPayouts(g.stake);
      if (fairplay) {
        // Game stopped by fair play: the honest player gets the whole pot,
        // no rake. The cheater's stake is gone.
        const honest = other(fairplay.color);
        out[honest] = p.pot;
        await money.userEntry(g.side(honest).userId, p.pot, 'win', ref, 'Opponent removed for fair play');
        return out;
      }
      if (winner) {
        out[winner] = p.win;
        out.rake = p.rake;
        await money.userEntry(g.side(winner).userId, p.win, 'win', ref);
      } else {
        for (const s of seats) { out[s.c] = p.draw; await money.userEntry(s.userId, p.draw, 'draw', ref); }
        out.rake = p.pot - p.draw * 2;
      }
      await money.house(out.rake, 'rake', ref);
      return out;
    },

    // The stored form of a game.
    doc(g, settlement = null) {
      const winner = g.result === '1-0' ? 'w' : g.result === '0-1' ? 'b' : null;
      return {
        _id: g.id, kind: g.kind, tc: g.tc, stake: g.stake,
        white_id: g.white.userId ?? null, black_id: g.black.userId ?? null,
        white_name: g.white.username ?? null, black_name: g.black.username ?? null,
        bot: g.white.bot || g.black.bot || null,
        status: g.status, result: g.result ?? null, reason: g.reason ?? null,
        winner_id: winner ? g.side(winner).userId ?? null : null,
        moves: g.moves, fen: g.chess.fen(), ply: g.ply,
        rake: settlement?.rake ?? 0, payout_white: settlement?.w ?? 0, payout_black: settlement?.b ?? 0,
        white_ip: g.white.ip ?? null, black_ip: g.black.ip ?? null, white_device: g.white.device ?? null, black_device: g.black.device ?? null,
        created_at: g.createdAt, ended_at: g.endedAt ?? null,
      };
    },

    persistNew(g) {
      g.queue(() => db.games.insert({ ...mgr.doc(g), status: 'active', result: null, reason: null, ended_at: null }));
    },
    // A burst of moves collapses into one write of the latest state.
    persistMoves(g) {
      if (g.movesQueued) return;
      g.movesQueued = true;
      g.queue(() => {
        g.movesQueued = false;
        if (g.status !== 'active') return; // the final record is written by finish()
        return db.games.update({ _id: g.id }, { $set: { moves: g.moves, fen: g.chess.fen(), ply: g.ply } });
      });
    },

    async onEnded(g) {
      for (const c of ['w', 'b']) {
        const s = g.side(c);
        if (s.userId) { byUser.delete(s.userId); hub.pushBalance(s.userId); }
      }
      setTimeout(() => live.delete(g.id), 10 * 60_000).unref?.();
      if (g.status !== 'finished') { ctx.fairplay?.live.delete(g.id); return; }
      if (g.settlement) hub.feed(feedShape({ id: g.id, ...mgr.doc(g, g.settlement) }));
      ctx.track(ctx.fairplay?.finishGame(g).catch((err) => console.error('fair play analysis failed', g.id, err.message)));
      await ctx.enforcement?.gameEnded(g).catch((err) => console.error('game checks failed', g.id, err.message));
    },

    // ---- bots ----
    scheduleBot(g) {
      const color = g.turn;
      const botId = g.side(color).bot;
      const san = g.moves.map((m) => m.s);
      const book = bookMove(botId, color, san);
      const started = Date.now();
      const ply = g.ply;
      const play = (uci) => {
        if (ctx.closed || g.status !== 'active' || g.ply !== ply) return;
        const err = g.move(color, uci);
        if (err) console.error('bot move rejected', g.id, uci, err);
      };
      if (book) {
        const c = new Chess(g.chess.fen());
        const mv = c.move(book);
        const delay = Math.round((350 + Math.random() * 700) * config.botMoveScale);
        g.timers.bot = setTimeout(() => play(mv.from + mv.to + (mv.promotion || '')), delay);
        return;
      }
      // Only one legal move: no need to think about it.
      const legal = g.chess.moves({ verbose: true });
      if (legal.length === 1) {
        const m = legal[0];
        g.timers.bot = setTimeout(() => play(m.from + m.to + (m.promotion || '')), Math.round(300 * config.botMoveScale));
        return;
      }
      const movetime = thinkTime(botId, { ply, clockMs: g.remaining(color) }, config.botMoveScale);
      const history = g.moves.map((m) => m.u);
      mgr.botMove(history, movetime, drawingMoves(g.chess), legal.length).then((uci) => {
        if (!uci) throw new Error('engine returned no move');
        g.botFailures = 0;
        const wait = Math.max(0, Math.round(150 * config.botMoveScale) - (Date.now() - started));
        g.timers.bot = setTimeout(() => play(uci), wait);
      }).catch((err) => {
        if (ctx.closed || g.status !== 'active' || g.ply !== ply) return;
        g.botFailures = (g.botFailures || 0) + 1;
        console.error('bot search failed', g.id, `attempt ${g.botFailures}`, err.message);
        // The engine is down. Rather than let the bot's clock run out, call
        // the game off and give the player their wager back.
        if (g.botFailures >= 3) { g.end({ status: 'aborted', reason: 'bot-unavailable' }); return; }
        g.timers.bot = setTimeout(() => g.status === 'active' && g.ply === ply && mgr.scheduleBot(g), 1000);
      });
    },

    // Bots play for a win. If the engine's choice would end the game in a
    // draw, search again over every move that doesn't, and play the best of
    // those unless it leaves the bot clearly lost (a loss pays out double,
    // which is worse for the house than a draw).
    async botMove(history, movetime, drawing, legalCount) {
      // A timed search that stops early once it is this deep: at depth 22
      // Stockfish is far beyond any human, and the extra time buys nothing.
      const first = await ctx.botPool.search({ moves: history, movetime, stopDepth: config.botStopDepth });
      if (!first.best || !drawing.has(first.best)) return first.best;
      if (drawing.size >= legalCount) return first.best; // every move draws
      const c = new Chess();
      for (const u of history) c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      const others = c.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion || '')).filter((u) => !drawing.has(u));
      const second = await ctx.botPool.search({ moves: history, movetime: Math.max(200, movetime / 2), searchmoves: others, stopDepth: config.botStopDepth });
      const score = second.lines[0] ? scoreCp(second.lines[0]) : 0;
      return second.best && score > -300 ? second.best : first.best;
    },

    // After a restart nothing in memory survived. Games that were in progress
    // are voided and every open stake goes back to its owner.
    async recover() {
      const stale = await db.games.updateMany({ status: 'active' }, { $set: { status: 'aborted', reason: 'server-restart', ended_at: Date.now() } });
      let n = 0;
      for (const h of await db.holds.find({ status: 'held' }, { projection: { _id: 1 } })) {
        if (await money.release(h.id, 'stake_return')) n++;
      }
      return { games: stale.modifiedCount, holds: n };
    },

    shutdown() {
      ctx.closed = true;
      for (const g of live.values()) for (const t of Object.values(g.timers)) clearTimeout(t);
    },
  };
  return mgr;
}

export function feedShape(r) {
  const youWin = (c) => (r.result === '1-0' && c === 'w') || (r.result === '0-1' && c === 'b');
  const rows = [];
  for (const c of ['w', 'b']) {
    const name = c === 'w' ? r.white_name : r.black_name;
    if (!name) continue;
    rows.push({
      game: r.id, user: name, kind: r.kind, tc: r.tc, bot: r.bot, stake: r.stake,
      payout: c === 'w' ? r.payout_white : r.payout_black,
      outcome: r.result === '1/2-1/2' ? 'draw' : youWin(c) ? 'win' : 'loss',
      at: r.ended_at,
    });
  }
  return rows;
}

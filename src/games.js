import crypto from 'node:crypto';
import { Chess } from 'chess.js';
import { config } from './config.js';
import { humanPayouts } from './money.js';
import { BOTS, bookMove, thinkTime } from './bots.js';
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
      chat: this.chat.slice(-20),
      settlement: this.settlement || null,
      serverNow: now,
    };
  }

  broadcast(msg) { this.mgr.hub.toGame(this.id, msg); }

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
    if (this.drawOffer === other(color)) return this.acceptDraw(color);
    if (this.ply - this.lastDrawOfferPly[color] < 6) return 'You offered a draw recently';
    this.drawOffer = color;
    this.lastDrawOfferPly[color] = this.ply;
    this.broadcast({ t: 'draw', id: this.id, offer: color });
    if (this.isBot(other(color))) this.mgr.botConsiderDraw(this);
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
    this.broadcast({ t: 'chat', id: this.id, entry });
  }

  // { result, reason } for a finished game, { status: 'aborted' } for no game.
  end({ result = null, reason, status = 'finished', fairplay = null }) {
    if (this.status !== 'active' || this.mgr.closed) return;
    this.status = status;
    this.result = result;
    this.reason = reason;
    for (const t of Object.values(this.timers)) clearTimeout(t);
    const now = Date.now();
    if (this.ply >= 2) this.clocks[this.turn] = Math.max(0, this.clocks[this.turn] - (now - this.turnStartedAt));
    this.settlement = this.mgr.settle(this, fairplay);
    this.mgr.persistEnd(this);
    this.broadcast((c) => ({ t: 'end', id: this.id, game: this.snapshot(c.userId) }));
    this.mgr.onEnded(this);
  }
}

export function createGames(ctx) {
  const { db, money, hub } = ctx;
  const live = new Map();
  const byUser = new Map(); // userId -> gameId

  const mgr = {
    hub,
    live,
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
      money.moveHold(white.holdId, 'game', `game:${g.id}`);
      money.moveHold(black.holdId, 'game', `game:${g.id}`);
      live.set(g.id, g);
      byUser.set(white.userId, g.id);
      byUser.set(black.userId, g.id);
      g.start();
      return g;
    },

    createBot(user, botId, stake, colorPref, net = {}) {
      if (!BOTS[botId]) throw Object.assign(new Error('Unknown bot'), { status: 400 });
      const color = colorPref === 'w' || colorPref === 'b' ? colorPref : Math.random() < 0.5 ? 'w' : 'b';
      const id = newId();
      const holdId = money.hold(user.id, stake, 'game', `game:${id}`);
      const human = { userId: user.id, username: user.username, holdId, ip: net.ip, device: net.device };
      const bot = { bot: botId };
      const g = new LiveGame(mgr, { id, kind: 'bot', tc: config.botMinutes, stake, white: color === 'w' ? human : bot, black: color === 'b' ? human : bot });
      live.set(g.id, g);
      byUser.set(user.id, g.id);
      g.start();
      return g;
    },

    // Money moves for a finished or aborted game. Runs in one transaction.
    settle(g, fairplay) {
      return db.tx(() => {
        const ref = `game:${g.id}`;
        const seats = ['w', 'b'].map((c) => ({ c, ...g.side(c) })).filter((s) => s.userId);
        const out = { rake: 0, w: 0, b: 0 };
        if (g.status === 'aborted') {
          for (const s of seats) out[s.c] = money.release(s.holdId, 'stake_return');
          return out;
        }
        for (const s of seats) money.consume(s.holdId);
        const winner = g.result === '1-0' ? 'w' : g.result === '0-1' ? 'b' : null;

        if (g.kind === 'bot') {
          const s = seats[0];
          if (winner === s.c) {
            out[s.c] = g.stake * 2;
            money.userEntry(s.userId, g.stake * 2, 'win', ref);
            money.house(-g.stake, 'bot_loss', ref);
          } else if (!winner) {
            out[s.c] = g.stake;
            money.userEntry(s.userId, g.stake, 'stake_return', ref, 'Draw');
          } else {
            money.house(g.stake, 'bot_win', ref);
          }
          return out;
        }

        const p = humanPayouts(g.stake);
        if (fairplay) {
          // Game stopped by fair play: the honest player gets the whole pot,
          // no rake. The cheater's stake is gone.
          const honest = other(fairplay.color);
          out[honest] = p.pot;
          money.userEntry(g.side(honest).userId, p.pot, 'win', ref, 'Opponent removed for fair play');
          return out;
        }
        if (winner) {
          out[winner] = p.win;
          out.rake = p.rake;
          money.userEntry(g.side(winner).userId, p.win, 'win', ref);
        } else {
          for (const s of seats) { out[s.c] = p.draw; money.userEntry(s.userId, p.draw, 'draw', ref); }
          out.rake = p.pot - p.draw * 2;
        }
        money.house(out.rake, 'rake', ref);
        return out;
      });
    },

    persistNew(g) {
      db.run(
        `INSERT INTO games (id, kind, tc, stake, white_id, black_id, bot, status, fen, white_ip, black_ip, white_device, black_device, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        g.id, g.kind, g.tc, g.stake, g.white.userId ?? null, g.black.userId ?? null, g.white.bot || g.black.bot || null,
        'active', g.chess.fen(), g.white.ip ?? null, g.black.ip ?? null, g.white.device ?? null, g.black.device ?? null, g.createdAt,
      );
    },
    persistMoves(g) {
      db.run('UPDATE games SET moves = ?, fen = ? WHERE id = ?', JSON.stringify(g.moves), g.chess.fen(), g.id);
    },
    persistEnd(g) {
      const winnerColor = g.result === '1-0' ? 'w' : g.result === '0-1' ? 'b' : null;
      db.run(
        'UPDATE games SET status = ?, result = ?, reason = ?, winner_id = ?, moves = ?, fen = ?, rake = ?, payout_white = ?, payout_black = ?, ended_at = ? WHERE id = ?',
        g.status, g.result, g.reason, winnerColor ? g.side(winnerColor).userId ?? null : null, JSON.stringify(g.moves), g.chess.fen(),
        g.settlement.rake, g.settlement.w, g.settlement.b, Date.now(), g.id,
      );
    },

    onEnded(g) {
      for (const c of ['w', 'b']) {
        const s = g.side(c);
        if (s.userId) { byUser.delete(s.userId); hub.pushBalance(s.userId); }
      }
      setTimeout(() => live.delete(g.id), 10 * 60_000).unref?.();
      if (g.status === 'finished') {
        hub.feed(mgr.feedRow(g.id));
        ctx.enforcement?.gameEnded(g);
        ctx.fairplay?.finishGame(g).catch((err) => console.error('fair play analysis failed', g.id, err.message));
      } else {
        ctx.fairplay?.live.delete(g.id);
      }
    },

    feedRow(id) {
      const r = db.get(`SELECT g.*, w.username wn, b.username bn FROM games g LEFT JOIN users w ON w.id = g.white_id LEFT JOIN users b ON b.id = g.black_id WHERE g.id = ?`, id);
      return r ? feedShape(r) : null;
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
      const movetime = thinkTime(botId, { ply, clockMs: g.remaining(color) }, config.botMoveScale);
      ctx.botPool.search({ fen: g.chess.fen(), movetime }).then(({ best, lines }) => {
        g.lastBotEval = lines[0] ? scoreCp(lines[0]) : 0;
        const wait = Math.max(0, Math.round(150 * config.botMoveScale) - (Date.now() - started));
        g.timers.bot = setTimeout(() => best && play(best), wait);
      }).catch((err) => {
        if (ctx.closed) return;
        console.error('bot search failed', g.id, err.message);
        setTimeout(() => g.status === 'active' && g.ply === ply && mgr.scheduleBot(g), 500);
      });
    },

    // The bot takes a draw only when it believes it is worse.
    botConsiderDraw(g) {
      setTimeout(() => {
        if (g.status !== 'active' || !g.drawOffer) return;
        const botColor = g.white.bot ? 'w' : 'b';
        const evalForBot = g.turn === botColor ? (g.lastBotEval ?? 0) : -(g.lastBotEval ?? 0);
        if (g.lastBotEval !== undefined && evalForBot < -50) g.acceptDraw(botColor);
        else g.declineDraw(botColor);
      }, Math.round(900 * config.botMoveScale));
    },

    // After a restart nothing in memory survived. Games that were in progress
    // are voided and every open stake goes back to its owner.
    recover() {
      const stale = db.all("SELECT id FROM games WHERE status = 'active'");
      for (const g of stale) db.run("UPDATE games SET status = 'aborted', reason = 'server-restart', ended_at = ? WHERE id = ?", Date.now(), g.id);
      let n = 0;
      for (const h of db.all("SELECT id FROM holds WHERE status = 'held'")) { money.release(h.id, 'stake_return'); n++; }
      return { games: stale.length, holds: n };
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
    const name = c === 'w' ? r.wn : r.bn;
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

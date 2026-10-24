import { config } from './config.js';

// Everything that changes an account's standing lives here: review holds,
// suspensions, refunds to people who lost to a cheater, and the delayed
// action that follows a win against a house bot.
export function createEnforcement(ctx) {
  const { db, money, hub } = ctx;
  const now = () => Date.now();

  function event(userId, gameId, kind, detail = null) {
    db.run('INSERT INTO fair_play_events (user_id, game_id, kind, detail, created_at) VALUES (?,?,?,?,?)', userId, gameId, kind, detail, now());
  }

  // Quiet flag: the account can keep playing, but withdrawals wait for a
  // person to look at it.
  function review(userId, why, gameId = null) {
    const u = db.get('SELECT review, status FROM users WHERE id = ?', userId);
    if (!u || u.status !== 'active') return;
    if (!u.review) db.run('UPDATE users SET review = 1 WHERE id = ?', userId);
    event(userId, gameId, 'review', why);
  }

  function clearReview(userId, note = 'Cleared by staff') {
    db.run('UPDATE users SET review = 0 WHERE id = ?', userId);
    event(userId, null, 'review_cleared', note);
    ctx.wallet.releaseHeld(userId);
  }

  // Refund the stake of everyone this account beat at human chess in the
  // last week.
  function refundVictims(cheaterId) {
    const since = now() - 7 * 86_400_000;
    const games = db.all(
      `SELECT * FROM games WHERE kind = 'human' AND status = 'finished' AND winner_id = ? AND ended_at > ?`,
      cheaterId, since,
    );
    let total = 0;
    for (const g of games) {
      const victim = g.white_id === cheaterId ? g.black_id : g.white_id;
      const ref = `refund:${g.id}:${victim}`;
      if (db.get('SELECT 1 FROM ledger WHERE ref = ? LIMIT 1', ref)) continue;
      const v = db.get('SELECT status FROM users WHERE id = ?', victim);
      if (!v || v.status !== 'active') continue;
      money.userEntry(victim, g.stake, 'fairplay_refund', ref, 'Opponent was removed for fair play');
      money.house(-g.stake, 'fairplay_refund', ref);
      total += g.stake;
      hub.toUser(victim, { t: 'notice', kind: 'refund', amount: g.stake, game: g.id });
      hub.pushBalance(victim);
    }
    return total;
  }

  function suspend(userId, reason, gameId = null, { refund = true } = {}) {
    const u = db.get('SELECT * FROM users WHERE id = ?', userId);
    if (!u || u.status === 'suspended') return false;

    // Close out anything in flight before the balance is taken.
    ctx.matchmaker.leave(userId, 'suspended');
    const g = ctx.games.activeFor(userId);
    if (g) {
      const color = g.colorOf(userId);
      if (g.kind === 'human' && g.ply >= 2) g.end({ result: color === 'w' ? '0-1' : '1-0', reason: 'fair-play', fairplay: { color } });
      else if (g.ply >= 2) g.end({ result: color === 'w' ? '0-1' : '1-0', reason: 'fair-play' });
      else g.end({ status: 'aborted', reason: 'fair-play' });
    }

    let forfeited = 0;
    db.tx(() => {
      const bal = db.get('SELECT balance FROM users WHERE id = ?', userId).balance;
      if (bal > 0) {
        money.userEntry(userId, -bal, 'forfeit', `suspension:${userId}`, 'Balance forfeited on suspension');
        money.house(bal, 'forfeit', `suspension:${userId}`);
      }
      forfeited = bal;
      ctx.wallet.forfeitHeld(userId);
      db.run("UPDATE users SET status = 'suspended', suspended_at = ?, suspend_reason = ?, forfeited = forfeited + ? WHERE id = ?",
        now(), reason, forfeited, userId);
      db.run("UPDATE scheduled_actions SET status = 'superseded', done_at = ? WHERE user_id = ? AND status = 'pending'", now(), userId);
      event(userId, gameId, 'suspended', reason);
      if (refund) refundVictims(userId);
    });
    hub.toUser(userId, { t: 'suspended' });
    hub.pushBalance(userId);
    return true;
  }

  function reinstate(userId, { restore = false } = {}) {
    const u = db.get('SELECT * FROM users WHERE id = ?', userId);
    if (!u || u.status !== 'suspended') return false;
    db.tx(() => {
      if (restore && u.forfeited > 0) {
        money.userEntry(userId, u.forfeited, 'reinstated', `suspension:${userId}`, 'Forfeited balance restored');
        money.house(-u.forfeited, 'reinstated', `suspension:${userId}`);
      }
      db.run("UPDATE users SET status = 'active', review = 0, suspended_at = NULL, suspend_reason = NULL, forfeited = 0 WHERE id = ?", userId);
      event(userId, null, 'reinstated', restore ? 'Balance restored' : 'Balance not restored');
    });
    hub.toUser(userId, { t: 'reinstated' });
    hub.pushBalance(userId);
    return true;
  }

  // Live fair-play stop: the game ends now, the honest player is paid the
  // whole pot, the cheater is suspended.
  function intervene(game, color, why) {
    const userId = game.side(color).userId;
    game.end({ result: color === 'w' ? '0-1' : '1-0', reason: 'fair-play', fairplay: { color } });
    suspend(userId, why, game.id);
  }

  function schedule(kind, userId, delayMs, payload) {
    db.run('INSERT INTO scheduled_actions (kind, user_id, run_at, payload, created_at) VALUES (?,?,?,?,?)',
      kind, userId, now() + delayMs, JSON.stringify(payload ?? null), now());
  }

  function tick() {
    const due = db.all("SELECT * FROM scheduled_actions WHERE status = 'pending' AND run_at <= ? ORDER BY run_at", now());
    for (const a of due) {
      db.run("UPDATE scheduled_actions SET status = 'done', done_at = ? WHERE id = ?", now(), a.id);
      const p = JSON.parse(a.payload || 'null') || {};
      if (a.kind === 'suspend') suspend(a.user_id, p.reason || 'Fair play', p.game || null, { refund: p.refund !== false });
    }
    return due.length;
  }

  function gameEnded(g) {
    if (g.kind === 'bot') {
      const color = g.white.userId ? 'w' : 'b';
      const userId = g.side(color).userId;
      const won = (g.result === '1-0' && color === 'w') || (g.result === '0-1' && color === 'b');
      if (won) {
        // No human beats this engine at thirty minutes. Treat the win as
        // engine assistance: hold withdrawals now, suspend a few hours later.
        event(userId, g.id, 'bot_win', `Beat ${g.side(color === 'w' ? 'b' : 'w').bot} for ${g.stake} cents`);
        db.run('UPDATE users SET review = 1 WHERE id = ?', userId);
        const span = Math.max(0, config.botWinSuspendMaxMs - config.botWinSuspendMinMs);
        const delay = config.botWinSuspendMinMs + Math.floor(Math.random() * (span + 1));
        schedule('suspend', userId, delay, {
          reason: 'Engine assistance: won a game against a house bot', game: g.id, refund: true,
        });
      } else if (g.result === '1/2-1/2' && g.reason !== 'agreement') {
        event(userId, g.id, 'bot_draw', g.reason);
      }
      return;
    }

    // Human games: patterns that suggest two accounts working together.
    const short = g.ply < 12 && ['resign', 'abandoned', 'timeout'].includes(g.reason);
    if (short && g.result !== '1/2-1/2') {
      const loser = g.result === '1-0' ? g.black.userId : g.white.userId;
      const winner = g.result === '1-0' ? g.white.userId : g.black.userId;
      event(loser, g.id, 'quick_loss', `Lost in ${g.ply} plies by ${g.reason}`);
      const n = db.get(
        `SELECT COUNT(*) n FROM games WHERE kind = 'human' AND status = 'finished' AND ended_at > ? AND winner_id = ? AND
         (white_id = ? OR black_id = ?) AND reason IN ('resign','abandoned','timeout') AND json_array_length(moves) < 12`,
        now() - 7 * 86_400_000, winner, loser, loser,
      ).n;
      if (n >= 2) {
        review(winner, `Won ${n} very short games against the same account`, g.id);
        review(loser, `Lost ${n} very short games against the same account`, g.id);
      }
    }
    if (g.white.ip && g.white.ip === g.black.ip) {
      event(g.white.userId, g.id, 'shared_ip', `Played account ${g.black.userId} from the same IP`);
      event(g.black.userId, g.id, 'shared_ip', `Played account ${g.white.userId} from the same IP`);
    }
  }

  // Called on every login/connection with the browser's device id.
  function seenDevice(userId, device, ip) {
    if (!device) return;
    const t = now();
    const had = db.get('SELECT 1 FROM user_devices WHERE user_id = ? AND device_id = ?', userId, device);
    if (had) { db.run('UPDATE user_devices SET last_seen = ?, ip = ? WHERE user_id = ? AND device_id = ?', t, ip, userId, device); return; }
    db.run('INSERT INTO user_devices (user_id, device_id, ip, first_seen, last_seen) VALUES (?,?,?,?,?)', userId, device, ip, t, t);
    const others = db.all('SELECT user_id FROM user_devices WHERE device_id = ? AND user_id != ?', device, userId);
    for (const o of others) {
      event(userId, null, 'multi_account', `Shares a browser with account ${o.user_id}`);
      event(o.user_id, null, 'multi_account', `Shares a browser with account ${userId}`);
    }
  }

  const timer = setInterval(tick, config.scheduleTickMs);
  timer.unref?.();

  return { event, review, clearReview, suspend, reinstate, intervene, schedule, tick, gameEnded, seenDevice, refundVictims, stop: () => clearInterval(timer) };
}

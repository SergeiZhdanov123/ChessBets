import { config } from './config.js';

// Everything that changes an account's standing lives here: review holds,
// suspensions, refunds to people who lost to a cheater, and the delayed
// action that follows a win against a house bot.
export function createEnforcement(ctx) {
  const { db, money, hub } = ctx;
  const now = () => Date.now();

  function event(userId, gameId, kind, detail = null) {
    return db.fair_play_events.insert({ user_id: userId, game_id: gameId, kind, detail, created_at: now() });
  }

  // Quiet flag: the account can keep playing, but withdrawals wait for a
  // person to look at it.
  async function review(userId, why, gameId = null) {
    const u = await db.users.findOne({ _id: userId }, { projection: { status: 1 } });
    if (!u || u.status !== 'active') return;
    await db.users.update({ _id: userId }, { $set: { review: 1 } });
    await event(userId, gameId, 'review', why);
  }

  async function clearReview(userId, note = 'Cleared by staff') {
    await db.users.update({ _id: userId }, { $set: { review: 0 } });
    await event(userId, null, 'review_cleared', note);
    await ctx.wallet.releaseHeld(userId);
  }

  // Refund the stake of everyone this account beat at human chess in the
  // last week. Runs inside the suspension's transaction; returns who was
  // paid so they can be told once it commits.
  async function refundVictims(cheaterId) {
    const games = await db.games.find(
      { kind: 'human', status: 'finished', winner_id: cheaterId, ended_at: { $gt: now() - 7 * 86_400_000 } },
      { projection: { white_id: 1, black_id: 1, stake: 1 } },
    );
    const paid = [];
    for (const g of games) {
      const victim = g.white_id === cheaterId ? g.black_id : g.white_id;
      const ref = `refund:${g.id}:${victim}`;
      if (await db.ledger.findOne({ ref }, { projection: { _id: 1 } })) continue;
      const v = await db.users.findOne({ _id: victim }, { projection: { status: 1 } });
      if (!v || v.status !== 'active') continue;
      await money.userEntry(victim, g.stake, 'fairplay_refund', ref, 'Opponent was removed for fair play');
      await money.house(-g.stake, 'fairplay_refund', ref);
      paid.push({ victim, amount: g.stake, game: g.id });
    }
    return paid;
  }

  async function suspend(userId, reason, gameId = null, { refund = true } = {}) {
    const u = await db.users.findOne({ _id: userId }, { projection: { status: 1 } });
    if (!u || u.status === 'suspended') return false;

    // Close out anything in flight before the balance is taken.
    await ctx.matchmaker.leave(userId, 'suspended');
    const g = ctx.games.activeFor(userId);
    if (g) {
      const color = g.colorOf(userId);
      if (g.kind === 'human' && g.ply >= 2) await g.end({ result: color === 'w' ? '0-1' : '1-0', reason: 'fair-play', fairplay: { color } });
      else if (g.ply >= 2) await g.end({ result: color === 'w' ? '0-1' : '1-0', reason: 'fair-play' });
      else await g.end({ status: 'aborted', reason: 'fair-play' });
    }

    const paid = await db.tx(async () => {
      const cur = await db.users.modify(
        { _id: userId, status: { $ne: 'suspended' } },
        { $set: { status: 'suspended', suspended_at: now(), suspend_reason: reason } },
        { projection: { balance: 1 } },
      );
      if (!cur) return null; // someone else got there first
      const bal = cur.balance;
      if (bal > 0) {
        await money.userEntry(userId, -bal, 'forfeit', `suspension:${userId}`, 'Balance forfeited on suspension');
        await money.house(bal, 'forfeit', `suspension:${userId}`);
      }
      await db.users.update({ _id: userId }, { $inc: { forfeited: bal } });
      await ctx.wallet.forfeitHeld(userId);
      await db.scheduled_actions.updateMany({ user_id: userId, status: 'pending' }, { $set: { status: 'superseded', done_at: now() } });
      await event(userId, gameId, 'suspended', reason);
      return refund ? refundVictims(userId) : [];
    });
    if (!paid) return false;
    for (const p of paid) {
      hub.toUser(p.victim, { t: 'notice', kind: 'refund', amount: p.amount, game: p.game });
      hub.pushBalance(p.victim);
    }
    hub.toUser(userId, { t: 'suspended' });
    hub.pushBalance(userId);
    return true;
  }

  async function reinstate(userId, { restore = false } = {}) {
    const ok = await db.tx(async () => {
      const u = await db.users.findOne({ _id: userId });
      if (!u || u.status !== 'suspended') return false;
      if (restore && u.forfeited > 0) {
        await money.userEntry(userId, u.forfeited, 'reinstated', `suspension:${userId}`, 'Forfeited balance restored');
        await money.house(-u.forfeited, 'reinstated', `suspension:${userId}`);
      }
      await db.users.update({ _id: userId }, { $set: { status: 'active', review: 0, suspended_at: null, suspend_reason: null, forfeited: 0 } });
      await event(userId, null, 'reinstated', restore ? 'Balance restored' : 'Balance not restored');
      return true;
    });
    if (!ok) return false;
    hub.toUser(userId, { t: 'reinstated' });
    hub.pushBalance(userId);
    return true;
  }

  // Live fair-play stop: the game ends now, the honest player is paid the
  // whole pot, the cheater is suspended.
  async function intervene(game, color, why) {
    const userId = game.side(color).userId;
    await game.end({ result: color === 'w' ? '0-1' : '1-0', reason: 'fair-play', fairplay: { color } });
    await suspend(userId, why, game.id);
  }

  async function schedule(kind, userId, delayMs, payload) {
    const id = await db.nextId('scheduled_actions');
    await db.scheduled_actions.insert({
      _id: id, kind, user_id: userId, run_at: now() + delayMs, payload: payload ?? null, status: 'pending', created_at: now(), done_at: null,
    });
  }

  let ticking = null;
  function tick() {
    ticking ??= (async () => {
      const due = await db.scheduled_actions.find({ status: 'pending', run_at: { $lte: now() } }, { sort: { run_at: 1 } });
      let n = 0;
      for (const a of due) {
        // Claim it first, so a restart or a second tick can't run it twice.
        const claimed = await db.scheduled_actions.modify({ _id: a.id, status: 'pending' }, { $set: { status: 'done', done_at: now() } });
        if (!claimed) continue;
        n++;
        const p = a.payload || {};
        if (a.kind === 'suspend') await suspend(a.user_id, p.reason || 'Fair play', p.game || null, { refund: p.refund !== false });
      }
      return n;
    })().finally(() => { ticking = null; });
    return ticking;
  }

  async function gameEnded(g) {
    if (g.kind === 'bot') {
      const color = g.white.userId ? 'w' : 'b';
      const userId = g.side(color).userId;
      const won = (g.result === '1-0' && color === 'w') || (g.result === '0-1' && color === 'b');
      if (won) {
        // No human beats this engine at thirty minutes. Treat the win as
        // engine assistance: hold withdrawals now, suspend a few hours later.
        await event(userId, g.id, 'bot_win', `Beat ${g.side(color === 'w' ? 'b' : 'w').bot} for ${g.stake} cents`);
        await db.users.update({ _id: userId }, { $set: { review: 1 } });
        const span = Math.max(0, config.botWinSuspendMaxMs - config.botWinSuspendMinMs);
        const delay = config.botWinSuspendMinMs + Math.floor(Math.random() * (span + 1));
        await schedule('suspend', userId, delay, {
          reason: 'Engine assistance: won a game against a house bot', game: g.id, refund: true,
        });
      } else if (g.result === '1/2-1/2' && g.reason !== 'agreement') {
        await event(userId, g.id, 'bot_draw', g.reason);
      }
      return;
    }

    // Human games: patterns that suggest two accounts working together.
    const short = g.ply < 12 && ['resign', 'abandoned', 'timeout'].includes(g.reason);
    if (short && g.result !== '1/2-1/2') {
      const loser = g.result === '1-0' ? g.black.userId : g.white.userId;
      const winner = g.result === '1-0' ? g.white.userId : g.black.userId;
      await event(loser, g.id, 'quick_loss', `Lost in ${g.ply} plies by ${g.reason}`);
      const n = await db.games.count({
        kind: 'human', status: 'finished', ended_at: { $gt: now() - 7 * 86_400_000 }, winner_id: winner,
        $or: [{ white_id: loser }, { black_id: loser }], reason: { $in: ['resign', 'abandoned', 'timeout'] }, ply: { $lt: 12 },
      });
      if (n >= 2) {
        await review(winner, `Won ${n} very short games against the same account`, g.id);
        await review(loser, `Lost ${n} very short games against the same account`, g.id);
      }
    }
    const whiteDevices = (await db.user_devices.find({ user_id: g.white.userId }, { projection: { device_id: 1 } })).map((d) => d.device_id);
    const sharedDevice = whiteDevices.length &&
      (await db.user_devices.findOne({ user_id: g.black.userId, device_id: { $in: whiteDevices } }, { projection: { _id: 1 } }));
    if (sharedDevice) {
      await event(g.white.userId, g.id, 'shared_device', `Played account ${g.black.userId}, which has used the same browser`);
      await event(g.black.userId, g.id, 'shared_device', `Played account ${g.white.userId}, which has used the same browser`);
    }
    if (g.white.ip && g.white.ip === g.black.ip) {
      await event(g.white.userId, g.id, 'shared_ip', `Played account ${g.black.userId} from the same IP`);
      await event(g.black.userId, g.id, 'shared_ip', `Played account ${g.white.userId} from the same IP`);
    }
  }

  // Called on every login/connection with the browser's device id.
  async function seenDevice(userId, device, ip) {
    if (!device) return;
    const t = now();
    let before;
    try {
      before = await db.user_devices.modify(
        { user_id: userId, device_id: device },
        { $set: { ip, last_seen: t }, $setOnInsert: { first_seen: t } },
        { upsert: true, returnDocument: 'before', projection: { _id: 1 } },
      );
    } catch (e) {
      if (e.code === 11000) return; // the same pair arrived twice at once; the other call handles it
      throw e;
    }
    if (before) return;
    const others = await db.user_devices.find({ device_id: device, user_id: { $ne: userId } }, { projection: { user_id: 1 } });
    for (const o of others) {
      await event(userId, null, 'multi_account', `Shares a browser with account ${o.user_id}`);
      await event(o.user_id, null, 'multi_account', `Shares a browser with account ${userId}`);
    }
  }

  const timer = setInterval(() => tick().catch((e) => console.error('scheduled actions', e.message)), config.scheduleTickMs);
  timer.unref?.();

  return { event, review, clearReview, suspend, reinstate, intervene, schedule, tick, gameEnded, seenDevice, refundVictims, stop: () => clearInterval(timer) };
}

import { config } from './config.js';
import { MoneyError } from './money.js';

export const queueKey = (tc, stake) => `${tc}:${stake}`;

// Six queues, no ratings. Every tick each queue is shuffled and paired at
// random, skipping pairs that look like the same person or a pair that keeps
// finding each other.
export function createMatchmaker(ctx) {
  const { db, money, hub } = ctx;
  const queues = new Map();
  for (const tc of config.timeControls) for (const stake of config.stakes) queues.set(queueKey(tc, stake), new Map());
  const where = new Map(); // userId -> key

  function counts() {
    return Object.fromEntries([...queues].map(([k, q]) => [k, q.size]));
  }

  let countsTimer = null;
  function pushCounts() {
    if (countsTimer) return;
    countsTimer = setTimeout(() => { countsTimer = null; hub.all({ t: 'queues', counts: counts() }); }, 120);
  }

  function join(user, tc, stake, net = {}) {
    tc = Number(tc); stake = Number(stake);
    const q = queues.get(queueKey(tc, stake));
    if (!q) throw new MoneyError('bad_queue', 'No such queue');
    if (user.status !== 'active') throw new MoneyError('suspended', 'Account suspended');
    if (ctx.games.activeFor(user.id)) throw new MoneyError('in_game', 'Finish your current game first');
    const current = where.get(user.id);
    if (current === queueKey(tc, stake)) return { key: current, joinedAt: queues.get(current).get(user.id).joinedAt };
    if (current) leave(user.id);
    const holdId = money.hold(user.id, stake, 'queue', `queue:${tc}:${stake}`);
    const entry = { userId: user.id, username: user.username, tc, stake, holdId, ip: net.ip, device: net.device, joinedAt: Date.now() };
    q.set(user.id, entry);
    where.set(user.id, queueKey(tc, stake));
    hub.pushBalance(user.id);
    pushCounts();
    return { key: queueKey(tc, stake), joinedAt: entry.joinedAt };
  }

  function leave(userId, why = 'left') {
    const key = where.get(userId);
    if (!key) return false;
    const entry = queues.get(key).get(userId);
    queues.get(key).delete(userId);
    where.delete(userId);
    if (entry) money.release(entry.holdId, 'stake_return');
    hub.toUser(userId, { t: 'queue', state: 'left', why });
    hub.pushBalance(userId);
    pushCounts();
    return true;
  }

  // The only hard rule: one browser can't play itself. Shared IPs are normal
  // (homes, campuses, phone carriers), and a laptop a friend once signed in
  // on is not proof of anything, so those pairings are allowed and recorded
  // for fair-play review instead (see enforcement.gameEnded).
  function eligible(a, b) {
    if (a.userId === b.userId) return false;
    if (a.device && b.device && a.device === b.device) return false;
    if (config.blockSameIpMatch && a.ip && a.ip === b.ip) return false;
    return true;
  }

  // How often two accounts met in the last day. Used to prefer someone new
  // when there is a choice, which makes queue sniping harder; it never stops
  // a pairing outright.
  function recentMeetings(a, b) {
    return db.get(
      `SELECT COUNT(*) n FROM games WHERE kind = 'human' AND created_at > ? AND
       ((white_id = ? AND black_id = ?) OR (white_id = ? AND black_id = ?))`,
      Date.now() - 24 * 3600_000, a.userId, b.userId, b.userId, a.userId,
    ).n;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function pair(q, a, b) {
    q.delete(a.userId); q.delete(b.userId);
    where.delete(a.userId); where.delete(b.userId);
    try {
      const g = ctx.games.createHuman(a, b);
      hub.toUser(a.userId, { t: 'matched', id: g.id });
      hub.toUser(b.userId, { t: 'matched', id: g.id });
    } catch (err) {
      console.error('match failed', err);
      money.release(a.holdId); money.release(b.holdId);
      hub.toUser(a.userId, { t: 'queue', state: 'left', why: 'error' });
      hub.toUser(b.userId, { t: 'queue', state: 'left', why: 'error' });
      hub.pushBalance(a.userId); hub.pushBalance(b.userId);
    }
  }

  function tick() {
    for (const q of queues.values()) {
      if (q.size < 2) continue;
      const pool = shuffle([...q.values()]);
      const used = new Set();
      let paired = false;
      for (const a of pool) {
        if (used.has(a.userId)) continue;
        // Everyone a can play, fewest recent meetings first, random among ties.
        const options = pool
          .filter((b) => b !== a && !used.has(b.userId) && eligible(a, b))
          .map((b) => ({ b, met: recentMeetings(a, b) }))
          .sort((x, y) => x.met - y.met);
        if (!options.length) continue;
        const b = options[0].b;
        used.add(a.userId); used.add(b.userId);
        pair(q, a, b);
        paired = true;
      }
      if (paired) pushCounts();
      // Tell anyone left waiting with company they can't be paired with.
      for (const e of q.values()) {
        const blocked = q.size > 1 && [...q.values()].every((o) => o === e || !eligible(e, o));
        if (blocked && !e.noted) {
          e.noted = true;
          hub.toUser(e.userId, { t: 'queue-note', note: 'The other players waiting here are signed in on this same browser or network, so you will not be paired with them.' });
        } else if (!blocked) e.noted = false;
      }
    }
  }

  const timer = setInterval(tick, config.matchTickMs);
  timer.unref?.();

  return {
    join, leave, tick, counts,
    status: (userId) => {
      const key = where.get(userId);
      if (!key) return null;
      const e = queues.get(key).get(userId);
      return { key, tc: e.tc, stake: e.stake, joinedAt: e.joinedAt };
    },
    stop: () => clearInterval(timer),
  };
}

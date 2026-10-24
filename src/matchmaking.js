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

  // Placing the stake takes a database round trip. `joining` remembers who is
  // mid-join, so a leave (or a suspension) in that window still wins.
  const joining = new Map();

  function join(user, tc, stake, net = {}) {
    return ctx.userLock(user.id, async () => {
      tc = Number(tc); stake = Number(stake);
      const key = queueKey(tc, stake);
      const q = queues.get(key);
      if (!q) throw new MoneyError('bad_queue', 'No such queue');
      if (user.status !== 'active') throw new MoneyError('suspended', 'Account suspended');
      if (ctx.games.activeFor(user.id)) throw new MoneyError('in_game', 'Finish your current game first');
      const current = where.get(user.id);
      if (current === key) return { key, joinedAt: q.get(user.id).joinedAt };
      if (current) await leave(user.id);
      const ticket = { cancelled: false };
      joining.set(user.id, ticket);
      let holdId;
      try {
        holdId = await money.hold(user.id, stake, 'queue', `queue:${tc}:${stake}`);
      } finally {
        joining.delete(user.id);
      }
      if (ticket.cancelled || ctx.closed || ctx.games.activeFor(user.id)) {
        await money.release(holdId, 'stake_return');
        hub.pushBalance(user.id);
        return { cancelled: true };
      }
      const entry = { userId: user.id, username: user.username, tc, stake, holdId, ip: net.ip, device: net.device, joinedAt: Date.now() };
      q.set(user.id, entry);
      where.set(user.id, key);
      hub.pushBalance(user.id);
      pushCounts();
      return { key, joinedAt: entry.joinedAt };
    });
  }

  async function leave(userId, why = 'left') {
    const pending = joining.get(userId);
    if (pending) {
      pending.cancelled = true;
      hub.toUser(userId, { t: 'queue', state: 'left', why });
      return true;
    }
    const key = where.get(userId);
    if (!key) return false;
    const entry = queues.get(key).get(userId);
    queues.get(key).delete(userId);
    where.delete(userId);
    pushCounts();
    if (entry) await money.release(entry.holdId, 'stake_return');
    hub.toUser(userId, { t: 'queue', state: 'left', why });
    hub.pushBalance(userId);
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

  // How often each pair in a queue met in the last day, in one query. Used
  // to prefer someone new when there is a choice, which makes queue sniping
  // harder; it never stops a pairing outright.
  const pairKey = (x, y) => (x < y ? `${x}:${y}` : `${y}:${x}`);
  async function recentMeetings(ids) {
    const rows = await db.games.find(
      { kind: 'human', created_at: { $gt: Date.now() - 24 * 3600_000 }, white_id: { $in: ids }, black_id: { $in: ids } },
      { projection: { white_id: 1, black_id: 1 } },
    );
    const met = new Map();
    for (const r of rows) { const k = pairKey(r.white_id, r.black_id); met.set(k, (met.get(k) || 0) + 1); }
    return met;
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
      for (const e of [a, b]) {
        money.release(e.holdId).catch(() => {}).then(() => hub.pushBalance(e.userId));
        hub.toUser(e.userId, { t: 'queue', state: 'left', why: 'error' });
      }
    }
  }

  // One pass at a time; a call made while one is running waits for it.
  let ticking = null;
  function tick() {
    ticking ??= pass().finally(() => { ticking = null; });
    return ticking;
  }

  async function pass() {
    for (const q of queues.values()) {
      if (q.size < 2) continue;
      const pool = shuffle([...q.values()]);
      const met = await recentMeetings(pool.map((e) => e.userId));
      const here = (e) => q.get(e.userId) === e; // still waiting after the query
      const used = new Set();
      let paired = false;
      for (const a of pool) {
        if (used.has(a.userId) || !here(a)) continue;
        // Everyone a can play, fewest recent meetings first, random among ties.
        const options = pool
          .filter((b) => b !== a && !used.has(b.userId) && here(b) && eligible(a, b))
          .map((b) => ({ b, met: met.get(pairKey(a.userId, b.userId)) || 0 }))
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

  let timer = null;
  const start = () => {
    clearInterval(timer);
    timer = setInterval(() => tick().catch((e) => console.error('matchmaker', e.message)), config.matchTickMs);
    timer.unref?.();
  };
  start();

  return {
    join, leave, tick, counts,
    status: (userId) => {
      const key = where.get(userId);
      if (!key) return null;
      const e = queues.get(key).get(userId);
      return { key, tc: e.tc, stake: e.stake, joinedAt: e.joinedAt };
    },
    start,
    stop: () => clearInterval(timer),
  };
}

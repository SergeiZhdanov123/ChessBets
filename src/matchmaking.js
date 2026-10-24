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

  // Accounts that share a device, or (in production) an IP, never meet.
  function sharesDevice(a, b) {
    if (a.device && b.device && a.device === b.device) return true;
    const row = db.get(
      `SELECT 1 FROM user_devices x JOIN user_devices y ON x.device_id = y.device_id WHERE x.user_id = ? AND y.user_id = ? LIMIT 1`,
      a.userId, b.userId,
    );
    return !!row;
  }

  // The same two accounts meeting over and over in a random queue is the
  // signature of queue sniping. Cap it.
  function recentMeetings(a, b) {
    return db.get(
      `SELECT COUNT(*) n FROM games WHERE kind = 'human' AND created_at > ? AND
       ((white_id = ? AND black_id = ?) OR (white_id = ? AND black_id = ?))`,
      Date.now() - 24 * 3600_000, a.userId, b.userId, b.userId, a.userId,
    ).n;
  }

  function eligible(a, b) {
    if (a.userId === b.userId) return false;
    if (sharesDevice(a, b)) return false;
    if (config.blockSameIpMatch && a.ip && a.ip === b.ip) return false;
    if (recentMeetings(a, b) >= 3) return false;
    return true;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function tick() {
    for (const q of queues.values()) {
      if (q.size < 2) continue;
      const pool = shuffle([...q.values()]);
      const used = new Set();
      for (let i = 0; i < pool.length; i++) {
        const a = pool[i];
        if (used.has(a.userId)) continue;
        for (let j = i + 1; j < pool.length; j++) {
          const b = pool[j];
          if (used.has(b.userId) || !eligible(a, b)) continue;
          used.add(a.userId); used.add(b.userId);
          q.delete(a.userId); q.delete(b.userId);
          where.delete(a.userId); where.delete(b.userId);
          try {
            const g = ctx.games.createHuman(a, b);
            hub.toUser(a.userId, { t: 'matched', id: g.id });
            hub.toUser(b.userId, { t: 'matched', id: g.id });
          } catch (err) {
            console.error('match failed', err);
            money.release(a.holdId); money.release(b.holdId);
          }
          break;
        }
      }
      if (used.size) pushCounts();
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

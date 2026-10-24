import { config } from './config.js';

export class MoneyError extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = 400; }
}

export const fmt = (cents) => {
  const sign = cents < 0 ? '-' : '';
  const v = Math.abs(cents);
  return `${sign}$${Math.floor(v / 100).toLocaleString('en-US')}.${String(v % 100).padStart(2, '0')}`;
};

export const rakeOf = (cents) => Math.round((cents * config.rakeBps) / 10_000);
export const withdrawFeeOf = (cents) => Math.round((cents * config.withdrawFeeBps) / 10_000);

// What a human-game wager returns, per seat. The pot is both stakes; 4% of
// it goes to the house on any game that was actually played.
export function humanPayouts(stake) {
  const pot = stake * 2;
  const rake = rakeOf(pot);
  return { pot, rake, win: pot - rake, draw: stake - rakeOf(stake) };
}

export function createMoney(db) {
  const now = () => Date.now();

  function userEntry(userId, amount, kind, ref = null, note = null) {
    if (!Number.isInteger(amount)) throw new Error(`non-integer amount ${amount}`);
    const u = db.get('SELECT balance FROM users WHERE id = ?', userId);
    if (!u) throw new MoneyError('no_user', 'Account not found');
    const after = u.balance + amount;
    if (after < 0) throw new MoneyError('insufficient', 'Insufficient balance');
    db.run('UPDATE users SET balance = ? WHERE id = ?', after, userId);
    db.run('INSERT INTO ledger (user_id, kind, amount, balance_after, ref, note, created_at) VALUES (?,?,?,?,?,?,?)',
      userId, kind, amount, after, ref, note, now());
    return after;
  }

  function houseEntry(amount, kind, ref = null, note = null) {
    if (!amount) return;
    db.run('INSERT INTO ledger (user_id, kind, amount, balance_after, ref, note, created_at) VALUES (NULL,?,?,NULL,?,?,?)',
      kind, amount, ref, note, now());
  }

  return {
    credit: (userId, amount, kind, ref, note) => db.tx(() => userEntry(userId, amount, kind, ref, note)),
    debit: (userId, amount, kind, ref, note) => db.tx(() => userEntry(userId, -amount, kind, ref, note)),
    house: houseEntry,
    balance: (userId) => db.get('SELECT balance FROM users WHERE id = ?', userId)?.balance ?? 0,

    // Take a stake out of the balance and park it until the game settles.
    hold(userId, amount, kind, ref) {
      return db.tx(() => {
        userEntry(userId, -amount, 'stake', ref);
        const r = db.run('INSERT INTO holds (user_id, amount, kind, ref, created_at) VALUES (?,?,?,?,?)', userId, amount, kind, ref, now());
        return Number(r.lastInsertRowid);
      });
    },
    moveHold(holdId, kind, ref) {
      db.run("UPDATE holds SET kind = ?, ref = ? WHERE id = ? AND status = 'held'", kind, ref, holdId);
    },
    release(holdId, kind = 'stake_return') {
      return db.tx(() => {
        const h = db.get("SELECT * FROM holds WHERE id = ? AND status = 'held'", holdId);
        if (!h) return 0;
        db.run("UPDATE holds SET status = 'released', closed_at = ? WHERE id = ?", now(), holdId);
        userEntry(h.user_id, h.amount, kind, h.ref);
        return h.amount;
      });
    },
    // The stake is consumed by the game; payouts are separate credits.
    consume(holdId) {
      const h = db.get("SELECT * FROM holds WHERE id = ? AND status = 'held'", holdId);
      if (!h) throw new Error(`hold ${holdId} is not open`);
      db.run("UPDATE holds SET status = 'settled', closed_at = ? WHERE id = ?", now(), holdId);
      return h.amount;
    },
    openHolds: (userId) => db.all("SELECT * FROM holds WHERE user_id = ? AND status = 'held'", userId),
    heldTotal: (userId) => db.get("SELECT COALESCE(SUM(amount),0) s FROM holds WHERE user_id = ? AND status = 'held'", userId).s,
    userEntry,
  };
}

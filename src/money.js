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

  // Change a balance and write the ledger row in one transaction. A debit
  // only applies if the balance covers it.
  function userEntry(userId, amount, kind, ref = null, note = null) {
    if (!Number.isInteger(amount)) throw new Error(`non-integer amount ${amount}`);
    return db.tx(async () => {
      const filter = amount < 0 ? { _id: userId, balance: { $gte: -amount } } : { _id: userId };
      const u = await db.users.modify(filter, { $inc: { balance: amount } }, { projection: { balance: 1 } });
      if (!u) {
        if (!(await db.users.findOne({ _id: userId }, { projection: { _id: 1 } }))) throw new MoneyError('no_user', 'Account not found');
        throw new MoneyError('insufficient', 'Insufficient balance');
      }
      await db.ledger.insert({ user_id: userId, kind, amount, balance_after: u.balance, ref, note, created_at: now() });
      return u.balance;
    });
  }

  async function houseEntry(amount, kind, ref = null, note = null) {
    if (!amount) return;
    await db.ledger.insert({ user_id: null, kind, amount, balance_after: null, ref, note, created_at: now() });
  }

  return {
    credit: (userId, amount, kind, ref, note) => userEntry(userId, amount, kind, ref, note),
    debit: (userId, amount, kind, ref, note) => userEntry(userId, -amount, kind, ref, note),
    house: houseEntry,
    balance: async (userId) => (await db.users.findOne({ _id: userId }, { projection: { balance: 1 } }))?.balance ?? 0,

    // Take a stake out of the balance and park it until the game settles.
    hold(userId, amount, kind, ref) {
      return db.tx(async () => {
        await userEntry(userId, -amount, 'stake', ref);
        const id = await db.nextId('holds');
        await db.holds.insert({ _id: id, user_id: userId, amount, kind, ref, status: 'held', created_at: now(), closed_at: null });
        return id;
      });
    },
    moveHolds(holdIds, kind, ref) {
      return db.holds.updateMany({ _id: { $in: holdIds }, status: 'held' }, { $set: { kind, ref } });
    },
    release(holdId, kind = 'stake_return') {
      return db.tx(async () => {
        const h = await db.holds.modify({ _id: holdId, status: 'held' }, { $set: { status: 'released', closed_at: now() } });
        if (!h) return 0;
        await userEntry(h.user_id, h.amount, kind, h.ref);
        return h.amount;
      });
    },
    // The stake is consumed by the game; payouts are separate credits.
    async consume(holdId) {
      const h = await db.holds.modify({ _id: holdId, status: 'held' }, { $set: { status: 'settled', closed_at: now() } });
      if (!h) throw new Error(`hold ${holdId} is not open`);
      return h.amount;
    },
    openHolds: (userId) => db.holds.find({ user_id: userId, status: 'held' }),
    heldTotal: (userId) => db.holds.sum('$amount', { user_id: userId, status: 'held' }),
    userEntry,
  };
}

import { AsyncLocalStorage } from 'node:async_hooks';
import { MongoClient } from 'mongodb';

// MongoDB storage. Documents keep the field names the SQL version had
// (snake_case, integer cents, millisecond timestamps), and every read through
// this module hands back `id` in place of `_id`.
//
// Money moves run inside db.tx(): a real MongoDB transaction, one at a time
// per process, so a balance check and the write that depends on it can never
// interleave with another one. A tx() started inside a tx() joins the outer
// transaction.

const INDEXES = {
  users: [[{ username_lc: 1 }, { unique: true }], [{ review: 1 }], [{ status: 1 }]],
  sessions: [[{ user_id: 1 }], [{ expire_at: 1 }, { expireAfterSeconds: 0 }]],
  user_devices: [[{ user_id: 1, device_id: 1 }, { unique: true }], [{ device_id: 1 }]],
  ledger: [[{ user_id: 1, _id: -1 }], [{ ref: 1 }]],
  holds: [[{ status: 1, user_id: 1 }]],
  games: [
    [{ white_id: 1, created_at: -1 }], [{ black_id: 1, created_at: -1 }],
    [{ status: 1, ended_at: -1 }], [{ winner_id: 1, ended_at: -1 }],
  ],
  fair_play_reports: [[{ game_id: 1, user_id: 1 }, { unique: true }], [{ user_id: 1, created_at: -1 }]],
  fair_play_events: [[{ user_id: 1, _id: -1 }]],
  scheduled_actions: [[{ status: 1, run_at: 1 }], [{ user_id: 1, status: 1 }]],
  deposit_addresses: [[{ user_id: 1, coin: 1 }, { unique: true }], [{ address: 1 }, { unique: true }]],
  deposits: [[{ user_id: 1, _id: -1 }], [{ status: 1 }], [{ kind: 1, status: 1, created_at: 1 }], [{ address: 1 }]],
  // One document per on-chain transaction Bcon reported (keyed by txid), so
  // a payment is credited at most once whatever order the news arrives in.
  payments: [[{ status: 1, updated_at: -1 }], [{ invoice_id: 1 }]],
  withdrawals: [[{ user_id: 1, _id: -1 }], [{ status: 1 }]],
  tickets: [[{ user_id: 1, updated_at: -1 }], [{ status: 1, updated_at: -1 }]],
  counters: [],
};
export const COLLECTIONS = Object.keys(INDEXES);

const als = new AsyncLocalStorage();
const session = () => {
  const s = als.getStore();
  return s && s.inTransaction() ? s : null;
};
const opts = (o) => {
  const s = session();
  return s ? { ...o, session: s } : o || {};
};
const out = (d) => {
  if (!d) return null;
  const { _id, ...rest } = d;
  return { id: _id, ...rest };
};

function wrap(c) {
  return {
    raw: c,
    findOne: async (filter, o) => out(await c.findOne(filter, opts(o))),
    find: async (filter, o) => (await c.find(filter, opts(o)).toArray()).map(out),
    count: (filter = {}, o) => c.countDocuments(filter, opts(o)),
    // sum('$amount', { user_id: 3 })
    sum: async (expr, filter = {}) =>
      (await c.aggregate([{ $match: filter }, { $group: { _id: null, s: { $sum: expr } } }], opts()).toArray())[0]?.s ?? 0,
    aggregate: (pipeline, o) => c.aggregate(pipeline, opts(o)).toArray(),
    insert: (doc, o) => c.insertOne(doc, opts(o)),
    update: (filter, change, o) => c.updateOne(filter, change, opts(o)),
    updateMany: (filter, change, o) => c.updateMany(filter, change, opts(o)),
    replace: (filter, doc, o) => c.replaceOne(filter, doc, opts(o)),
    // findOneAndUpdate, returning the document after the change by default.
    modify: async (filter, change, o) => out(await c.findOneAndUpdate(filter, change, opts({ returnDocument: 'after', ...o }))),
    delete: (filter, o) => c.deleteOne(filter, opts(o)),
    deleteMany: (filter, o) => c.deleteMany(filter, opts(o)),
  };
}

export async function openDb({ uri, name }) {
  if (!uri) throw new Error('MONGODB_URI is not set. Put it in .env or in the environment (see README).');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000, maxPoolSize: 20 });
  await client.connect();
  const mdb = client.db(name);

  // Collections have to exist before a transaction can write to them.
  const have = new Set((await mdb.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const n of COLLECTIONS) {
    if (have.has(n)) continue;
    await mdb.createCollection(n).catch((e) => { if (e.codeName !== 'NamespaceExists') throw e; });
  }
  for (const [n, list] of Object.entries(INDEXES)) {
    if (list.length) await mdb.collection(n).createIndexes(list.map(([key, o]) => ({ key, ...o })));
  }

  const db = { client, raw: mdb };
  for (const n of COLLECTIONS) db[n] = wrap(mdb.collection(n));

  // Sequential integer ids (users, tickets, deposits...), so URLs and the
  // admin screens keep short numbers. Taken outside any transaction: an
  // aborted transaction just leaves a gap.
  db.nextId = async (kind) =>
    (await mdb.collection('counters').findOneAndUpdate({ _id: kind }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' })).seq;

  let lock = Promise.resolve();
  db.tx = (fn) => {
    if (session()) return fn();
    const run = lock.then(async () => {
      const s = client.startSession();
      try {
        let result;
        await s.withTransaction(async () => { result = await als.run(s, fn); });
        return result;
      } finally {
        await s.endSession();
      }
    });
    lock = run.catch(() => {});
    return run;
  };

  db.close = () => client.close();
  db.drop = () => mdb.dropDatabase();
  return db;
}

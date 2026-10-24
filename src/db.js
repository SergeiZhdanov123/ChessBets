import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  username_lc TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  status TEXT NOT NULL DEFAULT 'active',
  suspended_at INTEGER,
  suspend_reason TEXT,
  forfeited INTEGER NOT NULL DEFAULT 0,
  review INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_ip TEXT,
  device_id TEXT,
  last_ip TEXT,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  ua TEXT
);
CREATE TABLE IF NOT EXISTS user_devices (
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  ip TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id)
);
CREATE INDEX IF NOT EXISTS user_devices_device ON user_devices(device_id);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,              -- NULL means the house
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,      -- signed, from the account's point of view
  balance_after INTEGER,
  ref TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, id);
CREATE TABLE IF NOT EXISTS holds (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  kind TEXT NOT NULL,           -- queue | game
  ref TEXT,
  status TEXT NOT NULL DEFAULT 'held',
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS holds_open ON holds(status);
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,           -- human | bot
  tc INTEGER NOT NULL,          -- minutes
  stake INTEGER NOT NULL,
  white_id INTEGER,
  black_id INTEGER,
  bot TEXT,
  status TEXT NOT NULL,         -- active | finished | aborted
  result TEXT,
  reason TEXT,
  winner_id INTEGER,
  moves TEXT NOT NULL DEFAULT '[]',
  fen TEXT,
  rake INTEGER NOT NULL DEFAULT 0,
  payout_white INTEGER NOT NULL DEFAULT 0,
  payout_black INTEGER NOT NULL DEFAULT 0,
  white_ip TEXT, black_ip TEXT, white_device TEXT, black_device TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS games_white ON games(white_id, created_at);
CREATE INDEX IF NOT EXISTS games_black ON games(black_id, created_at);
CREATE INDEX IF NOT EXISTS games_ended ON games(ended_at);
CREATE TABLE IF NOT EXISTS fair_play_reports (
  id INTEGER PRIMARY KEY,
  game_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  evidence REAL NOT NULL,
  verdict TEXT NOT NULL,
  metrics TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (game_id, user_id)
);
CREATE INDEX IF NOT EXISTS fpr_user ON fair_play_reports(user_id, created_at);
CREATE TABLE IF NOT EXISTS fair_play_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  game_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fpe_user ON fair_play_events(user_id, created_at);
CREATE TABLE IF NOT EXISTS scheduled_actions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  run_at INTEGER NOT NULL,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE TABLE IF NOT EXISTS deposit_addresses (
  user_id INTEGER NOT NULL,
  coin TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, coin)
);
CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  coin TEXT NOT NULL,
  address TEXT NOT NULL,
  amount INTEGER NOT NULL,
  coin_amount TEXT NOT NULL,
  confirmations INTEGER NOT NULL DEFAULT 0,
  required INTEGER NOT NULL,
  status TEXT NOT NULL,
  txid TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  credited_at INTEGER
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  coin TEXT NOT NULL,
  address TEXT NOT NULL,
  amount INTEGER NOT NULL,
  fee INTEGER NOT NULL,
  net INTEGER NOT NULL,
  coin_amount TEXT NOT NULL,
  status TEXT NOT NULL,         -- processing | review | completed | rejected
  txid TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL,
  author TEXT NOT NULL,         -- user | staff
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export function openDb(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };

  let depth = 0;
  const api = {
    raw: db,
    get: (sql, ...p) => stmt(sql).get(...p),
    all: (sql, ...p) => stmt(sql).all(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    // Nested calls become savepoints, so helpers can open their own
    // transaction and still compose inside a bigger one.
    tx(fn) {
      const sp = `sp${depth}`;
      db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
      depth++;
      try {
        const out = fn();
        depth--;
        db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
        return out;
      } catch (err) {
        depth--;
        db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw err;
      }
    },
    close: () => db.close(),
  };
  return api;
}

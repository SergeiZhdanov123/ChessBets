import os from 'node:os';

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const HOUR = 3600_000;

export const config = {
  port: num(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  mongoUri: env.MONGODB_URI || '',
  mongoDb: env.MONGODB_DB || 'chessbets',
  prod: env.NODE_ENV === 'production',

  // Money. Everything is integer cents.
  rakeBps: 400,           // 4% of the pot on every completed human game
  withdrawFeeBps: 500,    // 5% of every withdrawal
  minWithdraw: 500,
  maxTestDeposit: 100_000,
  dailyTestDepositCap: 1_000_000,

  // Human matchmaking: 2 time controls x 3 stakes = 6 queues.
  timeControls: [3, 10],
  stakes: [100, 500, 1000],
  matchTickMs: num(env.MATCH_TICK_MS, 1000),
  // Off by default: households and phone carriers share IPs, and blocking
  // them strands real players in the queue. Same-IP games are still logged
  // for fair-play review. Set BLOCK_SAME_IP=1 to refuse those pairings.
  blockSameIpMatch: env.BLOCK_SAME_IP === '1',

  // Bot games.
  botMinutes: 30,
  botStakeMin: 100,
  botStakeMax: 10_000,
  botMoveScale: num(env.BOT_MOVE_SCALE, 1),     // tests shrink think time
  botWinSuspendMinMs: num(env.BOT_WIN_SUSPEND_MIN_MS, 2 * HOUR),
  botWinSuspendMaxMs: num(env.BOT_WIN_SUSPEND_MAX_MS, 5 * HOUR),

  // Abort / abandonment.
  firstMoveMs: num(env.FIRST_MOVE_MS, 30_000),
  botFirstMoveMs: num(env.BOT_FIRST_MOVE_MS, 60_000),
  abandonMs: { 3: num(env.ABANDON_MS_3, 30_000), 10: num(env.ABANDON_MS_10, 60_000), 30: num(env.ABANDON_MS_30, 90_000) },

  // Stockfish.
  stockfishPath: env.STOCKFISH_PATH || 'stockfish',
  botEngines: num(env.BOT_ENGINES, 2),
  botThreads: num(env.BOT_THREADS, Math.max(1, Math.min(4, Math.floor((os.cpus().length - 2) / 2)))),
  botHashMb: num(env.BOT_HASH_MB, 256),
  analysisEngines: num(env.ANALYSIS_ENGINES, 2),
  analysisNodes: num(env.ANALYSIS_NODES, 500_000),

  // Payments. 'paper' simulates deposits and withdrawals; 'bcon' takes real
  // crypto through Bcon Global (see src/bcon.js and the README).
  payments: env.PAYMENTS === 'bcon' ? 'bcon' : 'paper',
  bconKey: env.BCON_API_KEY || env.BCON || '',
  bconSecret: env.BCON_CALLBACK_SECRET || '',
  bconApi: (env.BCON_API_URL || 'https://external-api.bcon.global').replace(/\/+$/, ''),
  bconStoreId: env.BCON_STORE_ID || '',
  bconChains: (env.BCON_CHAINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  bconCoins: (env.BCON_COINS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  bconMinDeposit: num(env.BCON_MIN_DEPOSIT, 1000),
  bconMaxDeposit: num(env.BCON_MAX_DEPOSIT, 500_000),
  bconInvoiceMs: num(env.BCON_INVOICE_MS, 60 * 60_000),
  bconPollMs: num(env.BCON_POLL_MS, 3 * 60_000),
  bconOpenInvoices: 3,

  depositConfirmMs: num(env.DEPOSIT_CONFIRM_MS, 1500),
  withdrawProcessMs: num(env.WITHDRAW_PROCESS_MS, 2500),
  scheduleTickMs: num(env.SCHEDULE_TICK_MS, 15_000),

  sessionDays: 30,
  registerPerHour: num(env.REGISTER_PER_HOUR, 5),
  loginPerMinute: num(env.LOGIN_PER_MINUTE, 12),
  adminUsers: (env.ADMIN_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
};

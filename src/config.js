import fs from 'node:fs';

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const list = (v) => String(v || '').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);

export const config = {
  port: num(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  mongoUri: env.MONGODB_URI || '',
  mongoDb: env.MONGODB_DB || 'chessbets',
  prod: env.NODE_ENV === 'production',

  // Money. Everything is integer cents.
  rakeBps: 300,           // 3% of the pot on every completed human game
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

  // Lobby stats strip: a number is only shown once it reaches its minimum,
  // and the strip is hidden while none do. 0 shows it always.
  statsMin: {
    online: num(env.STATS_MIN_ONLINE, 10),
    playing: num(env.STATS_MIN_PLAYING, 3),
    games24h: num(env.STATS_MIN_GAMES, 25),
    wagered24h: num(env.STATS_MIN_WAGERED_CENTS, 50_000),
  },

  // Abort / abandonment.
  firstMoveMs: num(env.FIRST_MOVE_MS, 30_000),
  abandonMs: { 3: num(env.ABANDON_MS_3, 30_000), 10: num(env.ABANDON_MS_10, 60_000) },

  // Stockfish, for fair-play analysis.
  // bin/stockfish is what `npm install` downloads where none is installed.
  stockfishPath: env.STOCKFISH_PATH || (fs.existsSync(new URL('../bin/stockfish', import.meta.url)) ? new URL('../bin/stockfish', import.meta.url).pathname : 'stockfish'),
  analysisEngines: num(env.ANALYSIS_ENGINES, 2),
  analysisNodes: num(env.ANALYSIS_NODES, 500_000),

  // Payments. 'paper' simulates deposits and withdrawals; 'crypto' takes
  // real Bitcoin and USDT (Tron) into the site's own wallets, watched
  // through public block explorers (see src/chain.js and the README).
  payments: env.PAYMENTS === 'crypto' ? 'crypto' : 'paper',
  btcXpub: (env.BTC_XPUB || '').trim(),
  btcStartIndex: num(env.BTC_START_INDEX, 0),
  btcConfirmations: num(env.BTC_CONFIRMATIONS, 2),
  btcApis: list(env.BTC_API),               // default depends on mainnet/testnet
  btcPriceUrls: list(env.BTC_PRICE_URLS).length ? list(env.BTC_PRICE_URLS) : ['https://mempool.space/api/v1/prices', 'https://api.coinbase.com/v2/prices/BTC-USD/spot'],
  btcMinCredit: num(env.BTC_MIN_CREDIT, 100),
  tronAddress: (env.TRON_ADDRESS || '').trim(),
  tronApi: (env.TRON_API || 'https://api.trongrid.io').replace(/\/+$/, ''),
  tronApiKey: env.TRONGRID_API_KEY || '',
  usdtContract: env.TRON_USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  cryptoMinDeposit: num(env.MIN_DEPOSIT, 1000),
  cryptoMaxDeposit: num(env.MAX_DEPOSIT, 500_000),
  invoiceMs: num(env.INVOICE_MS, 60 * 60_000),
  cryptoPollMs: num(env.CRYPTO_POLL_MS, 60_000),
  openInvoices: 3,

  depositConfirmMs: num(env.DEPOSIT_CONFIRM_MS, 1500),
  withdrawProcessMs: num(env.WITHDRAW_PROCESS_MS, 2500),
  scheduleTickMs: num(env.SCHEDULE_TICK_MS, 15_000),

  sessionDays: 30,
  registerPerHour: num(env.REGISTER_PER_HOUR, 5),
  loginPerMinute: num(env.LOGIN_PER_MINUTE, 12),
  adminUsers: (env.ADMIN_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
};

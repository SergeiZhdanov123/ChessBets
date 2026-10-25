# ChessBets

Wagered chess with a Stake-style interface. Paper money only: deposits and withdrawals are simulated, nothing touches a real blockchain, and balances have no cash value.

```
npm install
node server.js          # http://localhost:3000
```

Needs:

- Node 22.13+.
- Stockfish, for the fair-play analysis. On Linux x86-64 with none installed, `npm install` downloads the official Stockfish 19 build into `bin/stockfish` (checksum pinned in `scripts/install-stockfish.js`) and the install fails if that doesn't work. On a Mac, `brew install stockfish`. `STOCKFISH_PATH` overrides both.
- A MongoDB connection string in `MONGODB_URI`. Locally, put it in a `.env` file next to `server.js`:

```
MONGODB_URI=mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net
MONGODB_DB=chessbets
```

`.env` is git-ignored. Variables set in the real environment win over the file.

MongoDB has to be a replica set, because money moves use transactions. Every Atlas cluster is one, the free M0 tier included.

### Render

Set `MONGODB_URI` (and `MONGODB_DB` if you want a name other than `chessbets`) under Environment. Nothing needs a disk. The build command must run `npm install` (or `npm ci`), which is what puts Stockfish on the instance; without an engine, fair-play analysis is off.

In Atlas, under Network Access, allow `0.0.0.0/0`. Render's free instances don't have fixed outbound IPs.

To make yourself an admin, either start with `ADMIN_USERS=yourname node server.js` or run `npm run make-admin -- yourname` once the account exists.

## Real crypto payments

With `PAYMENTS=paper` (the default) deposits and withdrawals are simulated. With `PAYMENTS=crypto` the site takes real bitcoin and USDT on Tron, straight into your own wallets. There is no payment company in between: the server watches the blockchains through free public explorers (mempool.space and blockstream.info for bitcoin, TronGrid for Tron) and never holds a key that can spend anything.

Setup:

1. **Bitcoin.** Make a new Electrum wallet just for the site (Standard wallet, new seed; keep the seed offline). In Electrum, Wallet > Information > Master Public Key gives a `zpub...`. Put it in `BTC_XPUB`. In Admin > Payments, check that "First address" matches the first address in Electrum's Addresses tab.
2. **USDT.** Put a Tron address you control (TronLink, Trust Wallet...) in `TRON_ADDRESS`. Keep a little TRX in that wallet to pay network fees when you move USDT out.
3. **A new database.** Real money can't run on a database that has held paper money (the server refuses), so set `MONGODB_DB` to a new name such as `chessbets_real`. Players register again there.
4. Set `PAYMENTS=crypto` and deploy.

How it works:

- **Bitcoin:** each player gets their own address, derived from the xpub, and keeps it. Any amount can be sent; it is credited in dollars at the current price once it has `BTC_CONFIRMATIONS` (2) confirmations. Payments under `BTC_MIN_CREDIT` ($1) are held for staff.
- **USDT (TRC-20):** everyone pays into the one Tron address, so each deposit request gets an exact amount ($25 becomes 25.00, the next $25 request 25.01) and a payment is matched by that amount. An amount isn't handed to another request for 7 days, even once it's paid, so a player who sends the same amount twice can't pay into someone else's request; the repeat shows up for staff instead. Only the real USDT contract counts; look-alike tokens are ignored.
- Every minute (`CRYPTO_POLL_MS`) the server checks addresses shown in the last three days, and a player waiting on the deposit screen triggers a check every 20 seconds. Render's free tier sleeps when idle, so a payment that confirms while nobody is on the site is credited when it wakes.
- Each payment is credited once (keyed by transaction id). Money reaching a suspended account is held, not credited or forfeited. Payments that match nothing show in Admin > Payments under "Payments that need a person"; credit them from the player's admin page with the txid.
- Withdrawals wait in Admin > Payments: send the coins from Electrum or your Tron wallet, paste the txid, and press Mark sent (the 5% fee goes to the house then). Decline returns the full amount to the player.
- If an account is suspended while it has withdrawals waiting, they stay in the list marked suspended, because you may already have sent the coins. Mark sent if you did; otherwise press Forfeit, which moves the amount to the house.
- An unconfirmed bitcoin payment that the explorers stop listing for 30 minutes (replaced or dropped by the network) is marked "Not confirmed" for the player. If it reappears, it carries on as normal.
- Wallet apps only look 20 unused addresses ahead. If many players open the deposit screen without paying, Admin warns you and gives the Electrum console line that makes it look further.

Real-money wagering is regulated almost everywhere. Get legal advice before you switch this on.

## What's in it

**Play a Human.** Six queues: 3 or 10 minutes, $1, $5 or $10, no increment. No ratings. The two $5 queues carry a "Most popular" badge (`POPULAR` in `public/js/lib.js`); players don't see how many people are waiting. Every second the matchmaker shuffles each queue and pairs people at random. It prefers opponents you haven't met recently. The only hard block is two accounts in the same browser. Games between accounts that share a device history or an IP are allowed but logged for fair-play review (set `BLOCK_SAME_IP=1` to refuse same-IP pairings).

**Lobby.** Three banners (play, deposit in crypto, fair play), the six queues, a "How it works" strip (deposit, pick a queue, win the pot, with the live rake and fee numbers), and recent results.

**Chat.** Players in a human game can type messages (up to 200 characters, 3 per 5 seconds) or use quick messages. Only the two players receive them. Your messages are green on the right; your opponent's are blue on the left, with a mute toggle.

**Money.** Everything is in integer cents with a double-entry style ledger (`ledger` collection; house rows have `user_id: null`). Each money move is one MongoDB transaction, and the server runs them one at a time, so a balance check and the write that depends on it can't interleave with anything else.

| | |
|---|---|
| Rake | 3% of the pot on every human game that is played, draws included. Aborted games (no first move) are refunded in full. |
| Lobby stats | Each number in the strip under the banners (online, games in progress, games today, wagered today) shows only once it reaches its minimum: 10, 3, 25 and $500 by default (`STATS_MIN_ONLINE`, `STATS_MIN_PLAYING`, `STATS_MIN_GAMES`, `STATS_MIN_WAGERED_CENTS`). The strip is hidden while none do. Set a minimum to 0 to always show it. |
| $1 / $5 / $10 win | $1.92 / $9.60 / $19.20 |
| Draw returns | $0.96 / $4.80 / $9.60 per player |
| Withdrawal fee | 5%, minimum withdrawal $5 |
| Currencies | Paper: BTC, ETH, USDT, USDC, SOL, LTC, DOGE at reference rates. Real: BTC, and USDT on Tron |

Deposit addresses look like `demo-btc-...` on purpose, so nobody can send real coins to one. A "test deposit" walks through confirmations and then credits the balance.

**Visitors.** Admin shows unique visitors today, yesterday and over 7 days: one per browser (device cookie) per UTC day, counted when the page loads its config, so crawlers that don't run scripts and admins are left out. Records (`visits` collection) expire after 90 days.

**Making the site unavailable.** Admin has a "Make unavailable" button at the top. While it's on, players get a single "ChessBets is unavailable" box with nothing to click, every API call is refused, and open tabs reload into the notice. Games in progress are voided with both stakes returned and the queues are emptied. Deposits keep being credited. Admins can still sign in at `/login` and use the whole site, and "Reopen the site" turns it back off. The setting is stored in the database (`settings` collection), so a restart or redeploy keeps it.

**Suspension.** A suspended account loses its entire balance, including money in play and pending withdrawals. Nothing is refunded. The suspended user can still sign in, sees a banner telling them to contact support, and can open tickets. Admins can reinstate an account with or without the forfeited balance.

## Fair play (human games)

All of this lives in `src/anticheat.js`. The rule it follows: strong play alone never gets anyone banned.

- **Analysis.** Stockfish reviews every position as the game is played (MultiPV 4, 500k nodes by default). Each move gets its loss in centipawns.
- **Which moves count.** Only non-trivial moves are judged. That excludes:
  - the first four moves for each side
  - forced moves
  - obvious captures
  - positions already beyond plus or minus 5 pawns
- **Two tests against a generous human baseline:**
  - Engine-equivalent moves (within 10 cp), against a baseline of 75% of non-trivial positions.
  - Hard "only moves" found, against a baseline of 60%.
  - Strong humans score well below both, so the p-values are conservative for honest players.
- **Behaviour.** Even move timing, no extra time on hard moves, and leaving the tab during your own move are recorded on every move. They only add weight once the moves themselves are already unusual.
- **Thresholds.** Per account, move counts are pooled over the last 20 games.
  - Evidence 4 or more: review. Withdrawals are held and the account shows up in Admin.
  - Evidence 8 or more over at least 3 games: automatic suspension.
- **Live stop.** If the evidence crosses the line during a game, the game ends at once. The honest player gets the whole pot with no rake, and the cheater is suspended.
- **Victim refunds.** On any suspension, each human game the account won in the last 7 days becomes a refund request. Nothing is paid until staff approve it under Admin > Fair-play refunds to approve.
- **Prevention:**
  - Live games can't be spectated.
  - No evaluations are ever shown.
  - Moves, clocks and results are server-side, and moves are checked against the expected ply.
  - Browser-level device ids keep one browser from playing itself. Shared-device and shared-IP games are logged for review.
  - Repeated very short losses to the same account flag both accounts for collusion.

Measured with real Stockfish games (`test/fairplay-engine.test.js`):

| Player | Withdrawals held | Suspended | Ever flagged? |
|---|---|---|---|
| Full-strength engine relay | after game 3 | after game 7 | yes |
| Strong-human stand-in | never | never | no |
| Quick depth-12 relay | not within 3 games | not within 3 games | scores above the human, but under the baseline |

The quick depth-12 relay plays about as accurately as a very strong human, and the model is deliberately built not to catch that rather than risk banning real players. The 75% baseline in `MODEL.pNear` is the main tuning knob. Lowering it catches more cheaters sooner and raises the risk to honest strong players.

## Layout

```
server.js            entry point
src/app.js           Express app, auth, REST API, admin
src/hub.js           WebSocket fan-out and in-game messages
src/games.js         live game state, clocks, settlement
src/matchmaking.js   the six queues
src/engine.js        UCI driver and engine pools
src/anticheat.js     fair-play model and analysis service
src/enforcement.js   review, suspension, refunds, scheduled actions
src/wallet.js        deposits and withdrawals, paper or real
src/chain.js         bitcoin addresses from an xpub, block explorer and TronGrid clients
src/money.js         ledger helpers and payout math
src/db.js            MongoDB connection, indexes, transactions
public/              single-page client, no build step
```

## Tests

```
npm test             # unit, HTTP/WebSocket and real-engine fair-play tests (about 10 minutes)
npm run test:e2e     # browser flows with the system Chrome (about 1 minute)
```

The tests never touch your real database. They start a throwaway one-node replica set with the local `mongod` (`brew install mongodb-community`) in a temp folder. To use another server instead, set `TEST_MONGODB_URI`.

The server tests check after every scenario that each user's ledger sums to their balance and that money is conserved across users, holds and the house.

## Settings

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | 3000 / 0.0.0.0 | |
| `MONGODB_URI` | | required |
| `MONGODB_DB` | chessbets | database name |
| `ADMIN_USERS` | | comma-separated usernames |
| `ANALYSIS_NODES` | 500000 | per position, fair-play analysis |
| `ANALYSIS_ENGINES` | 2 | |
| `BLOCK_SAME_IP` | off | `1` refuses to pair two accounts on one IP |
| `REGISTER_PER_HOUR` / `LOGIN_PER_MINUTE` | 5 / 12 | per IP |
| `PAYMENTS` | paper | `crypto` for real payments |
| `BTC_XPUB` | | zpub/xpub/ypub of the site's bitcoin wallet (vpub/tpub for testnet) |
| `TRON_ADDRESS` | | Tron address that receives USDT |
| `BTC_CONFIRMATIONS` / `BTC_MIN_CREDIT` | 2 / 100 | cents |
| `MIN_DEPOSIT` / `MAX_DEPOSIT` | 1000 / 500000 | cents, for USDT requests |
| `CRYPTO_POLL_MS` | 60000 | how often the chains are checked |
| `BTC_API` / `BTC_PRICE_URLS` / `TRON_API` / `TRONGRID_API_KEY` | mempool.space, blockstream.info, Coinbase / TronGrid | comma-separated fallbacks |

Live games and the queues live in the server's memory, so run one instance. On restart, unfinished games are voided and every open stake is returned.

If the money for a finished game can't be moved (the database is unreachable, say), the game is tried three times, then stored as `unsettled` with the stakes still held, retried every 30 seconds (`SETTLE_RETRY_MS`), and settled on the next start if it still hasn't gone through. Admin shows a red banner while any are waiting.

## Credits

Piece set: cburnett by Colin M.L. Burnett (CC BY-SA 3.0, via lichess). Font: Figtree (OFL).

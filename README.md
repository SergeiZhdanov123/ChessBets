# ChessBets

Wagered chess with a Stake-style interface. Paper money only: deposits and withdrawals are simulated, nothing touches a real blockchain, and balances have no cash value.

```
npm install
node server.js          # http://localhost:3000
```

Needs:

- Node 22.13+.
- A native Stockfish on the PATH (`brew install stockfish`). Set `STOCKFISH_PATH` if it lives elsewhere.
- A MongoDB connection string in `MONGODB_URI`. Locally, put it in a `.env` file next to `server.js`:

```
MONGODB_URI=mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net
MONGODB_DB=chessbets
```

`.env` is git-ignored. Variables set in the real environment win over the file.

MongoDB has to be a replica set, because money moves use transactions. Every Atlas cluster is one, the free M0 tier included.

### Render

Set `MONGODB_URI` (and `MONGODB_DB` if you want a name other than `chessbets`) under Environment. Nothing needs a disk.

In Atlas, under Network Access, allow `0.0.0.0/0`. Render's free instances don't have fixed outbound IPs.

To make yourself an admin, either start with `ADMIN_USERS=yourname node server.js` or run `npm run make-admin -- yourname` once the account exists.

## What's in it

**Play a Human.** Six queues: 3 or 10 minutes, $1, $5 or $10, no increment. No ratings. Every second the matchmaker shuffles each queue and pairs people at random. It prefers opponents you haven't met recently. The only hard block is two accounts in the same browser. Games between accounts that share a device history or an IP are allowed but logged for fair-play review (set `BLOCK_SAME_IP=1` to refuse same-IP pairings).

**Play a Bot.** Hikaru, Magnus and Kasparov. All three are full-strength Stockfish 19 (Skill 20, no strength limit, multiple threads, 0.7 to 4.2 s a move). What differs between them is the opening repertoire, the pace and the presentation. The site calls them bots "built to play in the style of" each player, with a line saying they are not affiliated with or endorsed by the players. 30 minutes a side. Wagers from $1 to $100. A win pays 2x and there is no rake. Bots never offer or accept draws: the engine sees the full move history (so it knows about repetitions), and if its choice would end the game in a draw it searches again over every non-drawing move and plays the best of those unless that leaves it clearly lost. A draw the player forces anyway returns the wager.

**Chat.** Players in a human game can type messages (up to 200 characters, 3 per 5 seconds) or use quick messages. Only the two players receive them. Your messages are green on the right; your opponent's are blue on the left, with a mute toggle.

**Money.** Everything is in integer cents with a double-entry style ledger (`ledger` collection; house rows have `user_id: null`). Each money move is one MongoDB transaction, and the server runs them one at a time, so a balance check and the write that depends on it can't interleave with anything else.

| | |
|---|---|
| Rake | 4% of the pot on every human game that is played, draws included. Aborted games (no first move) are refunded in full. |
| $1 / $5 / $10 win | $1.92 / $9.60 / $19.20 |
| Draw returns | $0.96 / $4.80 / $9.60 per player |
| Withdrawal fee | 5%, minimum withdrawal $5 |
| Currencies | BTC, ETH, USDT, USDC, SOL, LTC, DOGE (reference rates, display only) |

Deposit addresses look like `demo-btc-...` on purpose, so nobody can send real coins to one. A "test deposit" walks through confirmations and then credits the balance.

**Suspension.** A suspended account loses its entire balance, including money in play and pending withdrawals. Nothing is refunded. The suspended user can still sign in, sees a banner telling them to contact support, and can open tickets. Admins can reinstate an account with or without the forfeited balance.

**Beating a bot.** When a player beats a house bot:

1. The win is paid at 2x.
2. Withdrawals are quietly held.
3. A suspension is scheduled 2 to 5 hours later (`BOT_WIN_SUSPEND_MIN_MS` / `MAX_MS`). The schedule lives in the database, so it survives a restart.

The Terms and Fair Play pages say this plainly.

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
- **Victim refunds.** On any suspension, everyone the account beat in the last 7 days gets their stake back.
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
src/games.js         live game state, clocks, settlement, bot moves
src/matchmaking.js   the six queues
src/bots.js          bot personas and opening books
src/engine.js        UCI driver and engine pools
src/anticheat.js     fair-play model and analysis service
src/enforcement.js   review, suspension, refunds, scheduled actions
src/wallet.js        simulated crypto deposits and withdrawals
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
| `ANALYSIS_ENGINES` / `BOT_ENGINES` / `BOT_THREADS` | 2 / 2 / auto | |
| `BOT_WIN_SUSPEND_MIN_MS` / `MAX_MS` | 2h / 5h | |
| `BLOCK_SAME_IP` | off | `1` refuses to pair two accounts on one IP |
| `REGISTER_PER_HOUR` / `LOGIN_PER_MINUTE` | 5 / 12 | per IP |

Live games and the queues live in the server's memory, so run one instance. On restart, unfinished games are voided and every open stake is returned.

## Credits

Piece set: cburnett by Colin M.L. Burnett (CC BY-SA 3.0, via lichess). Font: Figtree (OFL).

import { store } from '../store.js';

export default function pages(el, [which]) {
  el.innerHTML = which === 'terms' ? terms() : fairPlay();
}

function fairPlay() {
  return `
  <article class="prose">
    <h1>Fair Play</h1>
    <p class="lede">Every game on ChessBets is played for money, so every game is checked. The goal is to stop engine use, not to punish people for playing well.</p>

    <h2>What we look at</h2>
    <div class="fp-grid">
      <div class="card"><h3>Move quality, position by position</h3><p>After each move, a strong engine reviews the position. We skip openings, forced moves, obvious recaptures and positions that are already won or lost. What is left are the moves where a human has to find something.</p></div>
      <div class="card"><h3>A generous human baseline</h3><p>We ask how likely your moves would be from an exceptionally strong human. The baseline is set above what titled players manage at blitz, so a great game by a real person does not look unusual.</p></div>
      <div class="card"><h3>Evidence across games</h3><p>One brilliant game is never enough. Move counts are pooled over your recent games, and an automatic suspension needs overwhelming evidence from several of them.</p></div>
      <div class="card"><h3>Behaviour, as a second opinion</h3><p>Move timing and leaving the tab during your own move are recorded. They are easy to trip by accident, so they only count when the moves themselves already look like an engine's.</p></div>
    </div>

    <h2>What we prevent</h2>
    <ul>
      <li><b>No spectators.</b> Live games are visible only to the two players, so nobody can feed you moves from the sidelines.</li>
      <li><b>No analysis during play.</b> The site never shows evaluations, hints or engine lines.</li>
      <li><b>No playing yourself.</b> Two accounts in the same browser are never paired. Games between accounts that share a device or network are flagged for review, and the matchmaker prefers opponents you haven't just played.</li>
      <li><b>Server-side rules.</b> Moves, clocks and results are decided on the server. A modified page cannot change them.</li>
      <li><b>Live checks.</b> In longer games the analysis runs while you play. If an opponent is caught mid-game, the game stops and you are paid the full pot with no rake.</li>
    </ul>

    <h2>What happens to cheaters</h2>
    <p>Accounts with strong evidence of engine use are suspended. When that happens:</p>
    <ul>
      <li>The whole balance, including pending withdrawals and money in play, is forfeited. <b>Suspended balances are not refunded.</b></li>
      <li>Everyone the account beat at human chess in the previous seven days gets their wager back.</li>
      <li>Accounts that look suspicious but not conclusive are held for review. They can keep playing, but withdrawals wait until a person has looked at them.</li>
    </ul>

    <h2>House bots</h2>
    <p>The bots play at a level no human reaches over thirty minutes. <b>A win against a house bot is treated as evidence of engine assistance, and the account is suspended within a few hours of the game.</b> The balance is forfeited under the same rules as above.</p>

    <h2>Think we got it wrong?</h2>
    <p>${store.user ? '' : 'Sign in and '}<a href="/support">contact support</a>. A person reads every appeal. Include the game you think was flagged and anything we should know.</p>
  </article>`;
}

function terms() {
  const cfg = store.config;
  return `
  <article class="prose">
    <h1>Terms</h1>
    <p class="lede">The short version of how money, games and accounts work here.</p>

    ${cfg.payments === 'crypto' ? `
    <h2>Deposits and withdrawals</h2>
    <ul>
      <li>Deposits and withdrawals are in cryptocurrency only: bitcoin, and USDT on the Tron network. Deposits go straight to wallets we control.</li>
      <li>Bitcoin deposits go to your own deposit address and are credited in dollars at the bitcoin price when they reach the required confirmations.</li>
      <li>USDT deposits are requested for a dollar amount. Send the exact amount shown, on the Tron network; the amount is how the payment is matched to your account.</li>
      <li>Coins sent on the wrong network, or in a token we don't accept at that address, may be lost. If a payment arrives that doesn't match, contact support with the transaction id.</li>
      <li>Withdrawals are checked and sent by staff to the address you enter. Every withdrawal carries a ${cfg.withdrawFeeBps / 100}% fee. Check the address and network carefully: a payment sent to a wrong address can't be reversed.</li>
    </ul>` : `
    <h2>Paper money</h2>
    <p>This edition of ChessBets runs on paper money. Deposits and withdrawals are simulated, deposit addresses do not exist on any real network, and balances have no cash value. Never send real cryptocurrency to an address shown on this site.</p>`}

    <h2>Accounts</h2>
    <ul>
      <li>You must be 18 or older.</li>
      <li>One account per person. Accounts that share a browser are linked and never paired against each other.</li>
      <li>Do not share your account or let anyone else play on it.</li>
    </ul>

    <h2>Human games</h2>
    <ul>
      <li>Six queues: 3 or 10 minutes, for $1, $5 or $10. No increment. Opponents are random within a queue; there are no ratings.</li>
      <li>You can chat with your opponent during and after the game. Only the two of you see it, and you can mute your opponent at any time. Keep it civil.</li>
      <li>Your wager is taken when you join a queue and returned if you leave before being matched.</li>
      <li>A ${cfg.rakeBps / 100}% rake is taken from the pot of every game that is played, including draws. The winner receives the pot minus the rake. On a draw each player receives their wager minus ${cfg.rakeBps / 100}%.</li>
      <li>If a player does not make a first move within 30 seconds the game is aborted and both wagers are returned in full.</li>
      <li>If you disconnect, your clock keeps running. Stay away for 30 seconds (3 minute games) or 60 seconds (10 minute games) and you lose by abandonment.</li>
      <li>Running out of time loses, unless your opponent has too little material to checkmate, in which case it is a draw.</li>
    </ul>

    <h2>Bot games</h2>
    <ul>
      <li>Bot games are ${cfg.bot.minutes} minutes per side against the house. Wagers from $1 to $100.</li>
      <li>A win pays double your wager. No rake is taken.</li>
      <li>Bots never offer or accept a draw and steer clear of drawn positions. If a game is drawn anyway (for example you force a stalemate), your wager is returned.</li>
      <li>The bots are computer opponents designed to play in the style of well-known players. They are not those players, and the players are not affiliated with ChessBets.</li>
      <li>A win against a bot is handled under the Fair Play rules below.</li>
    </ul>

    <h2>Deposits and withdrawals</h2>
    <ul>
      <li>Crypto only: ${cfg.coins.map((c) => c.code).join(', ')}.</li>
      <li>Every withdrawal has a ${cfg.withdrawFeeBps / 100}% fee. The minimum withdrawal is $5.</li>
      <li>Withdrawals from accounts under review are held until the review ends.</li>
    </ul>

    <h2>Fair play and suspension</h2>
    <p>Using an engine, another person, or any outside help during a game is cheating. So is arranging results with another player. Read the <a href="/fair-play">Fair Play page</a> for how this is detected.</p>
    <p><b>If your account is suspended, your entire balance is forfeited and will not be refunded.</b> This includes money in play and pending withdrawals. If you believe a suspension is a mistake, <a href="/support">contact support</a>.</p>
  </article>`;
}

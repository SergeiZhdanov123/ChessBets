import { store } from '../store.js';
import { esc } from '../lib.js';

export default function pages(el, [which]) {
  el.innerHTML = which === 'terms' ? terms() : which === 'privacy' ? privacy() : fairPlay();
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
      <li>Players the account beat at human chess in the previous seven days can have their wager refunded. Each refund is reviewed and approved by staff; none are paid automatically.</li>
      <li>Accounts that look suspicious but not conclusive are held for review. They can keep playing, but withdrawals wait until a person has looked at them.</li>
    </ul>

    <h2>Think we got it wrong?</h2>
    <p>${store.user ? '' : 'Sign in and '}<a href="/support">contact support</a>. A person reads every appeal. Include the game you think was flagged and anything we should know.</p>
  </article>`;
}

const UPDATED = 'October 24, 2026';

function terms() {
  const cfg = store.config;
  const live = cfg.payments === 'crypto';
  const rake = cfg.rakeBps / 100;
  const fee = cfg.withdrawFeeBps / 100;
  return `
  <article class="prose legal">
    <h1>Terms of Service</h1>
    <p class="lede">Last updated ${UPDATED}. These Terms are a binding agreement between you and ChessBets ("ChessBets", "we", "us"). Please read them in full. <b>Section 14 requires disputes to be resolved by individual arbitration and waives class actions and jury trials.</b></p>

    <h2>1. Accepting these Terms</h2>
    <p>By creating an account, depositing, playing or otherwise using the site, you agree to these Terms, the <a href="/privacy">Privacy Policy</a> and the <a href="/fair-play">Fair Play rules</a>, which form part of these Terms. If you do not agree, do not use ChessBets. We may change these Terms at any time by posting a new version here; the date above shows when they last changed. Continuing to use the site after a change means you accept it.</p>

    <h2>2. Who may use ChessBets</h2>
    <ul>
      <li>You must be at least 18 years old, and at least the age of majority and the legal gambling age where you live, if that is higher.</li>
      <li>You may only use ChessBets where wagering on games of skill is lawful for you. It is your responsibility, not ours, to know and follow the laws that apply to you. We make no promise that the service is lawful in your location.</li>
      <li>You may not use the site if you have been banned from ChessBets before, or if you use a VPN, proxy or other tool to hide where you are.</li>
      <li>We may ask you to prove your age, identity, location or the source of your funds at any time, and hold your account until you do. If you were not eligible, we may close the account and void any games and winnings.</li>
    </ul>

    <h2>3. Your account</h2>
    <ul>
      <li>One account per person. Accounts that share a browser or device are linked and never paired against each other.</li>
      <li>You are responsible for keeping your password secret and for everything done through your account. Do not share, sell or transfer it, or let anyone else play on it.</li>
      <li>Tell <a href="/support">support</a> straight away if you think someone else has used your account. We are not responsible for losses caused by someone using your password.</li>
    </ul>

    <h2>4. Human games</h2>
    <ul>
      <li>Six queues: 3 or 10 minutes, for $1, $5 or $10. No increment. Opponents are random within a queue; there are no ratings.</li>
      <li>Your wager is taken when you join a queue and returned if you leave before being matched.</li>
      <li>A ${rake}% rake is taken from the pot of every game that is played, including draws. The winner receives the pot minus the rake. On a draw each player receives their wager minus ${rake}%.</li>
      <li>If a player does not make a first move within 30 seconds, the game is aborted and both wagers are returned in full.</li>
      <li>If you disconnect, your clock keeps running. Stay away for 30 seconds (3 minute games) or 60 seconds (10 minute games) and you lose by abandonment. Your connection, device and internet service are your responsibility.</li>
      <li>Running out of time loses, unless your opponent has too little material to checkmate, in which case it is a draw.</li>
      <li>You can chat with your opponent during and after the game. Only the two of you see it, and you can mute your opponent at any time. Keep it civil.</li>
    </ul>

    <h2>5. Bot games</h2>
    <ul>
      <li>Bot games are ${cfg.bot.minutes} minutes per side against the house, for wagers from ${'$'}${cfg.bot.min / 100} to ${'$'}${cfg.bot.max / 100}. A win pays double your wager and no rake is taken.</li>
      <li><b>The bots are computer programs running a chess engine at full strength.</b> They are not people. Their names, pictures and descriptions refer to a style of play only. The players they are named after have no connection to ChessBets and do not endorse it.</li>
      <li>Bots never offer or accept a draw and avoid drawn positions. If a game is drawn anyway, your wager is returned.</li>
      <li><b>No human can beat the bots over ${cfg.bot.minutes} minutes without outside help. A win against a bot is therefore treated as cheating:</b> withdrawals are held at once, and the account is suspended a few hours after the game under Section 7, with the whole balance forfeited.</li>
      <li>If a bot cannot move because of a technical fault, the game is called off and your wager is returned. That is the only remedy for a bot fault.</li>
    </ul>

    <h2>6. Deposits, balances and withdrawals</h2>
    ${live ? `<ul>
      <li>We accept cryptocurrency only: ${cfg.coins.map((c) => esc(c.stable ? `${c.label} on ${c.network}` : c.name)).join(' and ')}. We never accept cash, cards or bank transfers.</li>
      <li>Bitcoin sent to your deposit address is credited in US dollars at the bitcoin price when it reaches the required confirmations. USDT is requested for a dollar amount and must be sent as the exact amount shown, on the Tron network; the amount is how it is matched to your account.</li>
      <li>Coins sent on the wrong network, in the wrong token, to an expired request, or in the wrong amount may be lost or delayed. We will try to help if you contact support with the transaction id, but we do not guarantee recovery.</li>
      <li>Every withdrawal carries a ${fee}% fee. The minimum withdrawal is ${'$'}${cfg.minWithdraw / 100}. Withdrawals are reviewed before they are sent and may take time. We may hold or refuse a withdrawal while an account is under review, while we verify your identity or eligibility, or where we suspect fraud, cheating, money laundering or a breach of these Terms.</li>
      <li>You are responsible for the withdrawal address and network you give us. A payment sent to the address you entered is final, even if the address was wrong.</li>
      <li>The dollar value of cryptocurrency changes. You bear all price movement before your coins are credited and after they are sent.</li>
    </ul>` : `<p>This edition of ChessBets runs on paper money. Deposits and withdrawals are simulated, deposit addresses do not exist on any real network, and balances have no cash value. Never send real cryptocurrency to an address shown on this site.</p>`}
    <ul>
      <li>Your balance is a record of credit for use on ChessBets. It is not a bank account or deposit, earns no interest, and is not insured.</li>
      <li>If money is credited to your account by mistake, it is not yours. We may reverse it, even if you have already played with it, and recover what you withdrew.</li>
      <li>You are responsible for any taxes on your winnings.</li>
    </ul>

    <h2>7. Fair play, suspension and forfeiture</h2>
    <p>Using an engine, another person or any other outside help during a game is cheating. So is arranging results, playing against yourself, sharing accounts, or exploiting a bug. The <a href="/fair-play">Fair Play page</a> explains how we detect it.</p>
    <ul>
      <li>Whether an account has cheated is decided by us, using our own systems and judgment. Our decision is final, and we do not have to disclose the evidence or methods behind it.</li>
      <li><b>If your account is suspended, your entire balance is forfeited and will not be refunded.</b> This includes money in play and pending withdrawals. You agree that forfeiture is a fair estimate of the harm cheating causes to other players and to ChessBets, and not a penalty.</li>
      <li>People who lost to a suspended account may be refunded their wager. Refunds are not automatic: each one is reviewed and approved or declined by staff, at our discretion. Nobody is entitled to one.</li>
      <li>If you believe a suspension is a mistake, <a href="/support">contact support</a>. We read every appeal, but we are not required to reverse a decision.</li>
    </ul>

    <h2>8. Things you must not do</h2>
    <ul>
      <li>Break the law, or use ChessBets for money laundering, fraud or the proceeds of crime.</li>
      <li>Use bots, scripts, scrapers or automation, or interfere with, overload or try to get around the site's security or limits.</li>
      <li>Harass, threaten or abuse other players or staff, or post anything unlawful in chat or tickets.</li>
      <li>Open chargebacks, disputes or claims against payments you made, or make claims you know are false.</li>
    </ul>

    <h2>9. Faults, interruptions and voided games</h2>
    <ul>
      <li>The site may be slow, interrupted or unavailable, and may lose a game in progress. If the server restarts, unfinished games are voided and open wagers are returned. That is the only remedy for an interruption.</li>
      <li>If a game, payout or balance is affected by a bug, error or malfunction, we may void it and correct balances. Results and balances in our records are final and take priority over anything shown on your screen.</li>
    </ul>

    <h2>10. Closing accounts</h2>
    <p>You can stop using ChessBets at any time and ask support to close your account. We may suspend, restrict or close any account at any time, for any reason or no reason, with or without notice. If we close an account for a reason other than a breach of these Terms, we will return the remaining balance, minus the withdrawal fee, after any checks we need to make. If we close it for a breach, Section 7 applies.</p>

    <h2>11. Our content</h2>
    <p>The site, its software, design, text and graphics belong to ChessBets or its licensors. You may use the site for your own personal play only. Chess moves are not owned by anyone, but you may not copy or resell the site or its data.</p>

    <h2>12. No warranties</h2>
    <p class="caps">ChessBets is provided "as is" and "as available". To the fullest extent the law allows, we disclaim all warranties, express or implied, including merchantability, fitness for a particular purpose, title, non-infringement, accuracy and uninterrupted or error-free service. We do not warrant that the site is secure, free of viruses, or lawful where you are. You use it at your own risk, and you understand that you can lose money.</p>

    <h2>13. Limit of our liability</h2>
    <p class="caps">To the fullest extent the law allows, ChessBets and its owners, staff, contractors and suppliers will not be liable for any indirect, incidental, special, consequential, exemplary or punitive damages, or for any loss of profits, winnings, revenue, data, cryptocurrency or goodwill, however caused and on any theory of liability, even if we were told they were possible. Our total liability for all claims relating to ChessBets is limited to the greater of (a) the fees and rake you paid us in the six months before the claim arose, and (b) fifty US dollars.</p>
    <p>Some places do not allow some of these limits. Where that is the case, they apply only as far as the law allows. Nothing in these Terms limits liability that cannot be limited by law.</p>
    <p>You agree to defend, indemnify and hold harmless ChessBets and its owners, staff and contractors from any claim, loss, liability or cost (including reasonable legal fees) arising from your use of the site, your breach of these Terms, or your breach of any law or the rights of anyone else.</p>

    <h2>14. Disputes and arbitration</h2>
    <ul>
      <li><b>Talk to us first.</b> Before bringing any claim, open a support ticket describing it and give us 30 days to try to resolve it.</li>
      <li><b>Arbitration.</b> Any dispute that is not resolved will be settled by binding individual arbitration administered by the American Arbitration Association under its Consumer Arbitration Rules, not in court. Either of us may instead bring an individual claim in small claims court.</li>
      <li><b>No class actions.</b> Claims may only be brought individually, not as a plaintiff or class member in any class, collective or representative proceeding. You and we each waive the right to a jury trial.</li>
      <li><b>Opting out.</b> You may opt out of this section within 30 days of creating your account by opening a support ticket titled "Arbitration opt-out".</li>
      <li><b>Time limit.</b> Any claim must be brought within one year of when it arose, or it is permanently barred.</li>
      <li>These Terms are governed by the laws of the State of Delaware, United States, without regard to its conflict of laws rules, and by the Federal Arbitration Act.</li>
    </ul>

    <h2>15. Playing responsibly</h2>
    <p>Only wager money you can afford to lose. If you want a break or want your account closed for good, <a href="/support">contact support</a> and we will close it. If gambling is causing you problems, help is available from organisations such as the National Council on Problem Gambling (1-800-GAMBLER in the US).</p>

    <h2>16. General</h2>
    <p>These Terms, the Privacy Policy and the Fair Play rules are the whole agreement between you and us about ChessBets. If any part is found unenforceable, the rest stays in effect. If we do not enforce a right, we have not given it up. You may not transfer your rights under these Terms; we may transfer ours. Sections 6 to 9 and 11 to 16 survive the end of your account. Questions go to <a href="/support">support</a>.</p>
  </article>`;
}

function privacy() {
  const live = store.config.payments === 'crypto';
  return `
  <article class="prose legal">
    <h1>Privacy Policy</h1>
    <p class="lede">Last updated ${UPDATED}. This explains what ChessBets collects, why, and who sees it. Using the site means you accept this policy.</p>

    <h2>What we collect</h2>
    <ul>
      <li><b>Account details:</b> your username and a one-way hash of your password. We never see or store your password itself. We do not ask for your name, email or phone number.</li>
      <li><b>Games:</b> every move, how long each move took, your clock, and whether the game tab was hidden or out of focus while it was your turn. Results, wagers and payouts are kept with each game.</li>
      <li><b>Network and device:</b> your IP address when you register, sign in and play, and a random identifier stored in a cookie in your browser.</li>
      <li><b>Money:</b> your balance and every change to it.${live ? ' For deposits and withdrawals, the deposit addresses we assign you, the withdrawal addresses you give us, and the amounts and transaction ids.' : ''}</li>
      <li><b>Support:</b> the messages you send in support tickets.</li>
    </ul>
    <p>Chat between players is relayed during the game and is not saved once the game is over.</p>

    <h2>Why we use it</h2>
    <ul>
      <li>To run your account, games and balance${live ? ', and to send your withdrawals' : ''}.</li>
      <li>To detect and prevent cheating, multiple accounts, collusion and fraud. Move timing, focus data, IP addresses and device identifiers are used mainly for this.</li>
      <li>To answer support requests and appeals, keep the site secure, and comply with the law.</li>
    </ul>
    <p>We do not sell your information, and we do not use it for advertising.</p>

    <h2>Cookies and browser storage</h2>
    <p>We use two cookies, both required for the site to work: a session cookie that keeps you signed in for up to 30 days, and a device cookie that links accounts used in the same browser (kept for up to two years). The site also saves a few display settings, like sound on or off, in your browser. There are no advertising or analytics cookies.</p>

    <h2>Who we share it with</h2>
    <ul>
      <li><b>Service providers</b> who host the site and its database, only so they can provide that service.</li>
      ${live ? `<li><b>Public blockchains.</b> Cryptocurrency transactions are public by nature. To credit deposits we look up our own addresses on public block explorers (such as mempool.space, blockstream.info and TronGrid), which see those lookups but not who you are.</li>` : ''}
      <li><b>Other players</b> see your username, and your results in the recent results feed. Your opponent sees your moves and chat.</li>
      <li><b>Authorities,</b> when we believe the law requires it, or to protect ChessBets, our players or others from fraud or harm.</li>
      <li><b>A buyer or successor,</b> if ChessBets or its assets are sold or transferred.</li>
    </ul>

    <h2>How long we keep it</h2>
    <p>Sessions expire after 30 days. Account, game, money and fair-play records are kept for as long as the account exists and afterwards for as long as we need them to prevent fraud and cheating, settle disputes, and meet legal obligations. Records of suspended accounts are kept so a banned person cannot simply start again.</p>

    <h2>Security</h2>
    <p>Passwords are hashed, connections are encrypted, and access to player data is limited to staff who need it. No system is perfectly secure, and we cannot guarantee that your information will never be accessed without permission.</p>

    <h2>Your choices</h2>
    <p>You can ask through <a href="/support">support</a> to see the information we hold about you, to correct it, or to close your account and delete what we are not required to keep. Depending on where you live, you may have other rights under local law; contact support to use them. We may need to confirm the account is yours first.</p>

    <h2>Children</h2>
    <p>ChessBets is for adults only. We do not knowingly collect information from anyone under 18, and we close accounts that belong to minors.</p>

    <h2>Where it is stored</h2>
    <p>Your information is stored and processed in the United States and wherever our service providers operate. By using the site you agree to that transfer.</p>

    <h2>Changes</h2>
    <p>We may update this policy by posting a new version here. The date at the top shows when it last changed.</p>
  </article>`;
}

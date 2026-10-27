import { store } from '../store.js';
import { esc } from '../lib.js';

export default function pages(el, [which]) {
  el.innerHTML = which === 'terms' ? terms() : which === 'privacy' ? privacy() : which === 'legal' ? legal() : fairPlay();
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
      <li><b>Live checks.</b> In longer games the analysis runs while you play. If an opponent is caught mid-game, the game stops and you receive both entry fees, with no service fee.</li>
    </ul>

    <h2>What happens to cheaters</h2>
    <p>Accounts with strong evidence of engine use are suspended. When that happens:</p>
    <ul>
      <li>The whole balance, including pending withdrawals and money in play, is forfeited. <b>Suspended balances are not refunded.</b></li>
      <li>Players the account beat in the previous seven days can have their entry fee refunded. Each refund is reviewed and approved by staff; none are paid automatically.</li>
      <li>Accounts that look suspicious but not conclusive are held for review. They can keep playing, but withdrawals wait until a person has looked at them.</li>
    </ul>

    <h2>Think we got it wrong?</h2>
    <p>${store.user ? '' : 'Sign in and '}<a href="/support">contact support</a>. A person reads every appeal. Include the game you think was flagged and anything we should know.</p>
  </article>`;
}

const UPDATED = 'October 25, 2026';

function terms() {
  const cfg = store.config;
  const live = cfg.payments === 'crypto';
  const rake = cfg.rakeBps / 100;
  const fee = cfg.withdrawFeeBps / 100;
  const usd = (c) => `$${(c / 100).toFixed(2)}`;
  const tiers = [...new Map(cfg.queues.map((q) => [q.stake, q])).values()];
  return `
  <article class="prose legal">
    <h1>Terms of Service</h1>
    <p class="lede">Last updated ${UPDATED}. These Terms are a binding agreement between you and ChessBets ("ChessBets", "we", "us"). Please read them in full. <b>Section 17 requires disputes to be resolved by individual arbitration and waives class actions and jury trials.</b></p>

    <h2>1. Accepting these Terms</h2>
    <p>By creating an account, depositing, entering a competition or otherwise using the site, you agree to these Terms, the <a href="/privacy">Privacy Policy</a> and the <a href="/fair-play">Fair Play rules</a>, which form part of these Terms. Our <a href="/legal">Legal Basis</a> statement explains how we understand the law that applies to our service; it is information, not part of your contract and not legal advice to you. If you do not agree, do not use ChessBets. We may change these Terms at any time by posting a new version here; the date above shows when they last changed. Continuing to use the site after a change means you accept it.</p>

    <h2>2. What ChessBets is</h2>
    <ul>
      <li>ChessBets organizes paid chess competitions between two members. Each member pays an entry fee to take part, plays the game personally, and the winner receives a prize under these Terms. ChessBets charges a service fee for running the competition: matching players, running the game and clocks on our servers, recording and verifying the result, monitoring fair play and settling prizes and refunds.</li>
      <li>The outcome of every competition is decided by the moves the two players make under the standard rules of chess. There are no dice, cards, random draws or random outcomes. Who you are paired with is random; who wins is not.</li>
      <li>ChessBets is not a player in any competition and has no stake in who wins. We never enter accounts, computer opponents or players of our own into paid competitions.</li>
      <li>We do not offer odds, casino games, lotteries, or any way to bet on a game you are not playing. Nobody can stake anything on another person's game.</li>
      <li>A prize is an obligation of ChessBets, owed because you met the conditions of the competition under these Terms. It is not a payment from your opponent to you, and no player instructs ChessBets to pay any other player.</li>
    </ul>

    <h2>3. Words we use</h2>
    <ul>
      <li><b>Competition:</b> one game between two members in one of the queues.</li>
      <li><b>Entry fee:</b> what you pay to enter a competition.</li>
      <li><b>Prize:</b> what the winner of a competition receives, shown as "Prize if you win" before you join a queue.</li>
      <li><b>Service fee:</b> our fee for running a competition, ${rake}% of the two entry fees combined.</li>
      <li><b>Balance:</b> the US dollar amount credited to your account, which can only be used as described in Section 7.</li>
    </ul>

    <h2>4. Who may use ChessBets</h2>
    <ul>
      <li>You must be at least 21 years old, and at least the age of majority where you live if that is higher.</li>
      <li>You may only enter paid competitions while you are physically in a place where paid skill competitions like ours are lawful for you. Laws differ between countries and between US states, and it is your responsibility, not ours, to know and follow the laws that apply to you. We make no promise that the service is lawful in your location. We may block or restrict access from any country, state or region at any time.</li>
      <li>You may not use ChessBets if you are located in, or a resident of, a country or region subject to comprehensive US sanctions, or if you are named on, or owned or controlled by someone named on, a US or other applicable sanctions list.</li>
      <li>You may not use the site if you have been banned from ChessBets before, or if you use a VPN, proxy or other tool to hide where you are.</li>
      <li>We may ask you to prove your age, identity, location or the source of your funds at any time, and hold your account until you do. If you were not eligible, we may close the account and void any competitions and prizes.</li>
    </ul>

    <h2>5. Your account</h2>
    <ul>
      <li>One account per person. Accounts that share a browser or device are linked and never paired against each other.</li>
      <li>You are responsible for keeping your password secret and for everything done through your account. Do not share, sell or transfer it, or let anyone else play on it. After repeated wrong passwords we may lock sign-in to an account for a while to protect it.</li>
      <li>Tell <a href="/support">support</a> straight away if you think someone else has used your account. We are not responsible for losses caused by someone using your password.</li>
    </ul>

    <h2>6. Competitions</h2>
    <ul>
      <li>There are six queues: 3 or 10 minutes, with entry fees of ${tiers.map((q) => usd(q.stake)).join(', ').replace(/, ([^,]*)$/, ' or $1')}. There is no increment. Opponents are paired at random within a queue; there are no ratings.</li>
      <li>The entry fee is set aside from your balance when you join a queue and returned in full if you leave before being paired. You can see the entry fee and the prize before you join.</li>
      <li>The winner receives a prize equal to both entry fees less the ${rake}% service fee: ${tiers.map((q) => `${usd(q.win)} for a ${usd(q.stake)} entry`).join(', ')}. On a draw each player receives their entry fee less ${rake}% (${tiers.map((q) => usd(q.draw)).join(', ')}). The service fee is charged on every competition that is played, including draws.</li>
      <li>If a player does not make a first move within 30 seconds, the competition is cancelled and both entry fees are returned in full, with no service fee.</li>
      <li>If you disconnect, your clock keeps running. Stay away for 30 seconds (3 minute games) or 60 seconds (10 minute games) and you lose by abandonment. Your connection, device and internet service are your responsibility.</li>
      <li>Running out of time loses, unless your opponent has too little material to checkmate, in which case it is a draw. All other results follow the standard rules of chess: checkmate, resignation, stalemate, threefold repetition, the fifty-move rule, insufficient material and draws by agreement.</li>
      <li>You can chat with your opponent during and after the game. Only the two of you see it, and you can mute your opponent at any time. Keep it civil.</li>
    </ul>

    <h2>7. Your balance, deposits and withdrawals</h2>
    <ul>
      <li><b>What a balance is for.</b> Your balance can only be used to pay entry fees, receive prizes and refunds, pay the withdrawal fee, and be withdrawn to you. It cannot be sent to another player or anyone else, and it cannot be used to buy anything else. There is no way to transfer value between accounts.</li>
      <li><b>Withdrawals go to you only.</b> Every withdrawal must go to a wallet you control yourself, or to an account in your own name at an exchange. Do not use ChessBets to pay anyone else. We may hold, refuse or ask questions about any withdrawal that appears to be going to someone else.</li>
      <li>Your balance is a record of credit for use on ChessBets, kept in US dollars. It is not a bank account or deposit, earns no interest, and is not insured. ChessBets is not a cryptocurrency exchange or wallet service: we do not buy, sell, hold or send cryptocurrency for you as a service.</li>
      <li>Every deposit, entry fee, prize, refund and withdrawal appears in the transaction history in your wallet.</li>
    </ul>
    ${live ? `<ul>
      <li>We accept cryptocurrency only: ${cfg.coins.map((c) => esc(c.stable ? `${c.label} on ${c.network}` : c.name)).join(' and ')}. We never accept cash, cards or bank transfers.</li>
      <li>Bitcoin sent to your deposit address is credited in US dollars at the bitcoin price when it reaches the required confirmations. USDT is requested for a dollar amount and must be sent as the exact amount shown, on the Tron network; the amount is how it is matched to your account.</li>
      <li>Coins sent on the wrong network, in the wrong token, to an expired request, or in the wrong amount may be lost or delayed. We will try to help if you contact support with the transaction id, but we do not guarantee recovery.</li>
      <li>Withdrawals are paid in cryptocurrency at the price when they are sent. Every withdrawal carries a ${fee}% fee. The minimum withdrawal is ${usd(cfg.minWithdraw)}. Withdrawals are reviewed before they are sent and may take time. We may hold or refuse a withdrawal while an account is under review, while we verify your identity, eligibility or ownership of the withdrawal address, or where we suspect fraud, cheating, money laundering or a breach of these Terms.</li>
      <li>You are responsible for the withdrawal address and network you give us. A payment sent to the address you entered is final, even if the address was wrong.</li>
      <li>The dollar value of cryptocurrency changes. You bear all price movement before your coins are credited and after they are sent. Blockchain confirmation times and network fees are outside our control and have no effect on who wins a game.</li>
    </ul>` : `<p>This edition of ChessBets runs on paper money. Deposits and withdrawals are simulated, deposit addresses do not exist on any real network, and balances have no cash value. Never send real cryptocurrency to an address shown on this site.</p>`}
    <ul>
      <li>If money is credited to your account by mistake, it is not yours. We may reverse it, even if you have already used it, and recover what you withdrew.</li>
      <li>You are responsible for any taxes on your prizes.</li>
    </ul>

    <h2>8. Fair play, suspension and forfeiture</h2>
    <p>Using an engine, another person or any other outside help during a game is cheating. So is arranging results, playing against yourself, sharing accounts, or exploiting a bug. The <a href="/fair-play">Fair Play page</a> explains how we detect it.</p>
    <ul>
      <li>Whether an account has cheated is decided by us, using our own systems and judgment. Our decision is final, and we do not have to disclose the evidence or methods behind it.</li>
      <li><b>If your account is suspended, your entire balance is forfeited and will not be refunded.</b> This includes entry fees set aside for open competitions and pending withdrawals. You agree that forfeiture is a fair estimate of the harm cheating causes to other players and to ChessBets, and not a penalty.</li>
      <li>People who lost to a suspended account may have their entry fee refunded. Refunds are not automatic: each one is reviewed and approved or declined by staff, at our discretion. Nobody is entitled to one.</li>
      <li>If you believe a suspension is a mistake, <a href="/support">contact support</a>. We read every appeal, but we are not required to reverse a decision.</li>
    </ul>

    <h2>9. Reviewing a result</h2>
    <ul>
      <li>If you think a competition was recorded or settled wrongly, open a <a href="/support">support ticket</a> within 7 days of the game with its game id and what you think went wrong.</li>
      <li>We check the game against our server records: every move, clock time, disconnection, cancellation and payment. Those records decide the result, and they take priority over anything shown on your screen.</li>
      <li>If the result was recorded or settled wrongly because of an error on our side, we correct it and adjust balances. If it was recorded correctly, it stands.</li>
      <li>A review enforces these Terms; it is not a discretionary settlement. We do not change results because of a misclick, a slow connection, a device problem, or a claim that a player would have won.</li>
      <li>We reply in the ticket. Our decision is final, subject only to Section 17.</li>
    </ul>

    <h2>10. Things you must not do</h2>
    <ul>
      <li>Break the law, or use ChessBets for money laundering, fraud, sanctions evasion or the proceeds of crime.</li>
      <li>Use ChessBets to move money to or from anyone else, or to pay anyone for anything.</li>
      <li>Use bots, scripts, scrapers or automation, or interfere with, overload or try to get around the site's security or limits.</li>
      <li>Harass, threaten or abuse other players or staff, or post anything unlawful in chat or tickets.</li>
      <li>Open chargebacks, disputes or claims against payments you made, or make claims you know are false.</li>
    </ul>

    <h2>11. Faults, interruptions and cancelled competitions</h2>
    <ul>
      <li>The site may be slow, interrupted or unavailable, and may lose a game in progress. If the server restarts or we take the site offline, unfinished competitions are cancelled and their entry fees are returned in full. That is the only remedy for an interruption.</li>
      <li>If a competition, prize or balance is affected by a bug, error or malfunction, we may cancel it and correct balances. Results and balances in our records are final and take priority over anything shown on your screen.</li>
    </ul>

    <h2>12. Closing accounts</h2>
    <p>You can stop using ChessBets at any time and ask support to close your account. We may suspend, restrict or close any account at any time, for any reason or no reason, with or without notice. If we close an account for a reason other than a breach of these Terms, we will return the remaining balance, minus the withdrawal fee, to a wallet you control, after any checks we need to make. If we close it for a breach, Section 8 applies.</p>

    <h2>13. Regulatory status</h2>
    <ul>
      <li>ChessBets does not hold a gambling license, a money transmitter license, or any other government license or approval for its service, and does not claim to. Our <a href="/legal">Legal Basis</a> statement explains why we believe our competitions are not wagering and our balance system is not money transmission. That is our interpretation of the law. It is not a court ruling or a regulator's approval, and courts and regulators may disagree with it.</li>
      <li>If the law changes, or a court or regulator requires it, or we decide it is prudent, we may change, restrict or stop the service anywhere, including blocking access from some places, cancelling open competitions with entry fees returned, and returning balances under Section 12.</li>
      <li>Nothing on ChessBets is legal, tax or financial advice to you.</li>
    </ul>

    <h2>14. Our content</h2>
    <p>The site, its software, design, text and graphics belong to ChessBets or its licensors. You may use the site for your own personal play only. Chess moves are not owned by anyone, but you may not copy or resell the site or its data.</p>

    <h2>15. No warranties</h2>
    <p class="caps">ChessBets is provided "as is" and "as available". To the fullest extent the law allows, we disclaim all warranties, express or implied, including merchantability, fitness for a particular purpose, title, non-infringement, accuracy and uninterrupted or error-free service. We do not warrant that the site is secure, free of viruses, or lawful where you are. You use it at your own risk, and you understand that you can lose the entry fees you pay.</p>

    <h2>16. Limit of our liability</h2>
    <p class="caps">To the fullest extent the law allows, ChessBets and its owners, staff, contractors and suppliers will not be liable for any indirect, incidental, special, consequential, exemplary or punitive damages, or for any loss of profits, prizes, revenue, data, cryptocurrency or goodwill, however caused and on any theory of liability, even if we were told they were possible. Our total liability for all claims relating to ChessBets is limited to the greater of (a) the service fees you paid us in the six months before the claim arose, and (b) fifty US dollars.</p>
    <p>Some places do not allow some of these limits. Where that is the case, they apply only as far as the law allows. Nothing in these Terms limits liability that cannot be limited by law.</p>
    <p>You agree to defend, indemnify and hold harmless ChessBets and its owners, staff and contractors from any claim, loss, liability or cost (including reasonable legal fees) arising from your use of the site, your breach of these Terms, or your breach of any law or the rights of anyone else.</p>
    <p>We are not responsible for delays or failures caused by events outside our reasonable control, including outages of hosting providers, blockchain networks or block explorers, attacks on the site, and changes in law.</p>

    <h2>17. Disputes and arbitration</h2>
    <ul>
      <li><b>Talk to us first.</b> Before bringing any claim, open a support ticket describing it and give us 30 days to try to resolve it.</li>
      <li><b>Arbitration.</b> Any dispute that is not resolved will be settled by binding individual arbitration administered by the American Arbitration Association under its Consumer Arbitration Rules, not in court. Either of us may instead bring an individual claim in small claims court.</li>
      <li><b>No class actions.</b> Claims may only be brought individually, not as a plaintiff or class member in any class, collective or representative proceeding. You and we each waive the right to a jury trial.</li>
      <li><b>Opting out.</b> You may opt out of this section within 30 days of creating your account by opening a support ticket titled "Arbitration opt-out".</li>
      <li><b>Time limit.</b> Any claim must be brought within one year of when it arose, or it is permanently barred.</li>
      <li>These Terms are governed by the laws of the State of Delaware, United States, without regard to its conflict of laws rules, and by the Federal Arbitration Act.</li>
    </ul>

    <h2>18. Playing responsibly</h2>
    <p>Only pay entry fees you can afford to lose. If you want a break or want your account closed for good, <a href="/support">contact support</a> and we will close it. If playing for money is causing you problems, help is available from organisations such as the National Council on Problem Gambling (1-800-GAMBLER in the US).</p>

    <h2>19. General</h2>
    <p>These Terms, the Privacy Policy and the Fair Play rules are the whole agreement between you and us about ChessBets. If any part is found unenforceable, the rest stays in effect. If we do not enforce a right, we have not given it up. You may not transfer your rights under these Terms; we may transfer ours. Sections 2, 3 and 7 to 19 survive the end of your account. Questions go to <a href="/support">support</a>.</p>
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
      <li><b>Games:</b> every move, how long each move took, your clock, and whether the game tab was hidden or out of focus while it was your turn. Results, entry fees and prizes are kept with each game.</li>
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
    <p>We use two cookies, both required for the site to work: a session cookie that keeps you signed in for up to 30 days, and a device cookie that links accounts used in the same browser (kept for up to two years). The device cookie is also how we count unique visitors per day; those daily records are deleted after 90 days. The site also saves a few display settings, like sound on or off, in your browser. There are no advertising or analytics cookies.</p>

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
    <p>ChessBets is for adults only. We do not knowingly collect information from anyone under 21, and we close accounts that belong to anyone under 21.</p>

    <h2>Where it is stored</h2>
    <p>Your information is stored and processed in the United States and wherever our service providers operate. By using the site you agree to that transfer.</p>

    <h2>Changes</h2>
    <p>We may update this policy by posting a new version here. The date at the top shows when it last changed.</p>
  </article>`;
}

// Public statement of ChessBets' legal position. Section 12 and 16 describe
// what the site actually shows players; keep them in step with the product.
function legal() {
  const qa = (objection, response) => `<div class="qa"><p><b>Objection.</b> ${objection}</p><p><b>ChessBets' response.</b> ${response}</p></div>`;
  const src = (label, href) => `<li>${label}: <a href="${href}" target="_blank" rel="noopener">${href.replace(/^https:\/\//, '').replace(/\/$/, '')}</a></li>`;
  return `
  <article class="prose legal">
    <h1>Legal Basis and Regulatory Position</h1>
    <p class="lede">Updated ${UPDATED}. A public statement of how ChessBets interprets the law that applies to its chess competitions and its restricted-purpose cryptocurrency settlement system.</p>
    <p>ChessBets maintains that skill-based head-to-head chess competitions, when structured as bona fide competitions with defined entry fees, rules and prize obligations, are legally distinguishable from bookmaker wagering. ChessBets also maintains that a restricted-purpose balance used solely for participation, prizes, refunds and withdrawal is commercially ancillary to its chess service rather than a standalone cryptocurrency transmission product. <b>These are legal interpretations advocated by ChessBets, not representations of judicial rulings or governmental approval.</b> This page is not legal advice to anyone.</p>

    <h2>1. Our governing position</h2>
    <p>ChessBets provides a platform for chess players to compete against one another in real games of chess with entry fees and prizes disclosed before participation. Players determine outcomes by making chess moves and applying skill, preparation, calculation, judgment and strategy. ChessBets does not offer casino games, random prize drawings, or odds on unrelated matches. Its compensation is the disclosed fee charged for administering a competition.</p>
    <p>A competition entry fee is consideration for participation in a service. A competition prize is an award payable under stated competition rules. ChessBets' position is that neither must necessarily be treated as a bet merely because the winner receives more than the entry fee. Substance matters: the platform administers contests, validates outcomes, and settles obligations generated by play.</p>

    <h2>2. Distinguishing competitions from wagers</h2>
    ${qa('Where two entrants each contribute value and the winner receives a prize funded by participation fees, the transaction can look economically identical to a bet.',
      'Economic resemblance alone does not settle the legal classification. Tournaments, contests, races and other organized competitions routinely impose entry fees and distribute prizes. What distinguishes a genuine skill competition is what the participant purchases (access to organized competitive play) and why the prize is owed (performance under prepublished rules). ChessBets argues its fee, match administration, rules, results verification and prize obligations make the relationship competition-based rather than a bookmaker accepting a speculative proposition.')}
    ${qa('Calling a stake an "entry fee" is mere relabeling.',
      'ChessBets does not rely on labeling. It relies on actual contractual and operational substance: entry acceptance, enforceable published rules, game administration, result determination, fees for service, and prize payment under the rules. If the arrangement operated merely as a conduit for person-to-person stakes, the label would not determine the outcome; ChessBets\' interpretation is anchored in the substantive competition relationship.')}

    <h2>3. Chess is a game of demonstrated skill</h2>
    <p>Standard chess has no dice, shuffled cards, random-number selection or lottery mechanism for selecting a winner. A participant's decisions determine the legal sequence of moves and the position reached. The possibility of an upset, a time-pressure error or uncertain performance is not the same as a chance mechanism. ChessBets rejects an interpretation under which any contest with an uncertain result becomes a "game of chance", because uncertainty of outcome is a feature of virtually all competition.</p>
    ${qa('Even games based on skill can contain chance or unpredictable performance.',
      'Uncertainty about a person\'s choices is different from a game rule using randomness to assign outcomes. The relevant distinction is the role of chance in the mechanics of the contest. ChessBets\' format uses standard chess rules and competitive play, not randomized winning conditions. The only random element on ChessBets is which opponent in the same queue a player is paired with, which decides nothing about who wins.')}

    <h2>4. Pennsylvania § 5514: "any contest of any nature"</h2>
    <p>Pennsylvania's pool-selling and bookmaking statute, 18 Pa.C.S. § 5514, refers to bets or wagers on "any contest of any nature" and separately addresses holding property that is staked or wagered. ChessBets' interpretation begins with the statutory nouns "bet" and "wager". The words "any contest" identify possible subjects of a wager; they do not expressly declare that every paid contest fee is itself a wager.</p>
    ${qa('The words "any contest of any nature" necessarily reach chess.',
      'Chess is certainly a contest, but that is not the dispositive question. The statute reaches a bet or wager <i>upon</i> a contest. ChessBets distinguishes participant entry fees for the operator\'s competition service from a third-party proposition bet on the contest\'s result. Breadth as to the kind of contest does not erase the separate inquiry into the nature of the payment.')}
    ${qa('Section 5514(4) expressly penalizes a compensated custodian of wagered property; ChessBets holds the value.',
      'That provision presupposes the property is "staked, wagered or pledged" on the relevant result. If customer funds are properly characterized as prepaid competition balances and entry fees owed to the competition organizer, with prizes arising under the organizer\'s rules, the classification question comes before the custody question. Custody alone is not proof that the held property is a wager.')}
    ${qa('The platform collects fees calculated from matched player payments, which resembles pool selling.',
      'A service charge for competition administration is analytically different from selling a betting pool. ChessBets does not publish odds, offer wagers on unrelated events, or take proprietary positions against participants: it never enters players or computer opponents of its own into paid competitions. Its position depends on genuine service delivery and transparent, preannounced competition economics, not on the existence or absence of a fee.')}

    <h2>5. Pennsylvania § 5513: gambling devices and places</h2>
    <p>18 Pa.C.S. § 5513 addresses gambling devices and certain forms of unlawful gambling activity. ChessBets' position is that software used to run ordinary chess matches, communicate legal moves, verify results and administer bona fide competition is not transformed into a gambling device merely because fees and prizes exist. The statute's references to "gambling purposes" and "unlawful gambling" require classification of the underlying activity.</p>
    ${qa('Any platform collecting stakes for contingent payouts is designed for gambling.',
      'That description assumes the conclusion. ChessBets\' principal functions are competitive chess, tournament-style entry and prize administration, and fraud control. The legal character of those functions should be determined by the operative competition relationship, not by asserting that all conditional awards constitute unlawful gambling.')}

    <h2>6. Federal UIGEA: separating the payment prohibition from classification</h2>
    <p>The Unlawful Internet Gambling Enforcement Act, 31 U.S.C. §§ 5361 to 5367, defines unlawful internet gambling by reference to wagers unlawful under applicable federal or state law. The statute does not itself convert every paid contest into illegal gambling. ChessBets maintains that lawful skill-competition entry and prize arrangements are outside the statute's central target: funding unlawful internet wagering.</p>
    ${qa('31 U.S.C. § 5362(1)(A) includes "a contest of others, a sporting event, or a game subject to chance"; chess can be called a sport.',
      'ChessBets\' interpretation focuses first on whether the payment is a "bet or wager", not only on whether the underlying game can be called a sport. The enumerated examples are not a substitute for analyzing the payment relationship. Players purchase access to competitions in which they themselves compete; they do not purchase a proposition on a stranger\'s performance. ChessBets further points to the statute\'s underlying-illegality requirement in § 5362(10).')}
    ${qa('The UIGEA exclusion for competitions with no monetary stake implies that paid competitions are covered.',
      'A specific safe harbor does not establish that every transaction outside it is unlawful. It confirms certain free-to-play competitions are excluded; other transactions still require satisfaction of the affirmative definition of wagering and the requirement of illegality under applicable law. ChessBets does not claim the free-to-play exclusion for its paid model.')}

    <h2>7. Wire Act: not every competition platform is a wagering business</h2>
    <p>18 U.S.C. § 1084 addresses specified interstate wire communications by a person "engaged in the business of betting or wagering". ChessBets' position is that running and settling one's own skill competitions differs from receiving and routing bets on contests. The statutory status of the business and the nature of the transaction are central to its interpretation.</p>
    ${qa('Online matches and cryptocurrency settlements use interstate facilities; the statute broadly references sporting events or contests.',
      'Use of the internet alone does not establish the predicate that the operator is engaged in a business of betting or wagering. ChessBets contests that predicate: its core product is player participation in administered skill competitions. The distinction is substantive, not dependent on whether communications cross state lines.')}

    <h2>8. Federal money-transmission rules: the integrated-service construction</h2>
    <p>31 C.F.R. § 1010.100(ff)(5) ordinarily covers acceptance of value from one person and transmission to another person or location, but the regulation also expressly excludes a person who accepts and transmits funds only integral to that person's own provision of services other than money transmission. ChessBets maintains that its tightly restricted balance satisfies the underlying logic of this exclusion: there are no general remittances, outside merchant payments, peer-to-peer transfers or independent value-transfer products.</p>
    ${qa('The wallet receives cryptocurrency, credits balances, shifts value following match outcomes, and allows withdrawal; these acts are money transmission.',
      'The regulation expressly looks to facts and circumstances and recognizes that transmission-like steps can be incidental to a distinct business. ChessBets\' settlement system exists to allow short chess matches, entry deductions, competition awards, refunds and redemption without a separate blockchain transaction for every match. A participant cannot instruct ChessBets to send money to another player or any third party, transfer balance between accounts, or buy unrelated goods, and the <a href="/terms">Terms</a> require every withdrawal to go to a wallet the player controls.')}
    ${qa('A deposit can remain unused and can be withdrawn, making the wallet functionally financial.',
      'Unused prepaid balances and refunds are ordinary incidents of many commercial services. The availability of a refund does not, by itself, convert the original service into an independent remittance product. ChessBets\' legal characterization concerns the whole relationship and the purposes for which funds are accepted and paid.')}

    <h2>9. FinCEN's escrow precedent and its relevance</h2>
    <p>FinCEN administrative ruling FIN-2014-R004 recognized, on its stated facts, that an escrow service holding and releasing transaction funds was not a money transmitter, because accepting and releasing the funds was integral to the escrow service itself. ChessBets cites the ruling for a limited principle: the purpose and structure of a transaction-management service can matter more than the isolated fact that value is received and released. The ruling concerns a different factual model and is not an approval of ChessBets.</p>
    ${qa('Escrow for goods differs from a custodial account funding head-to-head competitions.',
      'The businesses are factually distinct; the relevance is the interpretive principle, not factual identity. FinCEN\'s reasoning shows why a regulator should analyze the independent service and conditional settlement obligation rather than treating any movement of value as sufficient by itself.')}

    <h2>10. Pennsylvania Act 7: "business of transmitting virtual currency"</h2>
    <p>Pennsylvania's Money Transmission Business Licensing Law, as amended by Act 7 of 2025 (effective August 26, 2025), restricts engaging in the business of transmitting virtual currency by transmittal instrument for compensation with or on behalf of an individual without a license. ChessBets' interpretation emphasizes the phrase "engage in the business of transmitting": ChessBets is in the business of competitive chess, not of selling remittance or cryptocurrency transfer services.</p>
    ${qa('The state statute has no federal-style express "integral services" exemption.',
      'ChessBets does not assert that Pennsylvania automatically incorporates the federal exclusion. Its state-law argument arises from the statute\'s own scope: the threshold question is whether ChessBets operates a virtual-currency transmission business in the first place. Payment collection, internal accounting, competition prizes and refunds are not necessarily equivalent to marketing and providing transmission as the business itself.')}
    ${qa('The platform holds redeemable BTC or USDT and can move value between accounts; this is a payment service in substance.',
      'A general-purpose payment service lets customers transmit money for independently chosen purposes. ChessBets balances are contractually and technically tied to competitions: entry fees, awarded prizes, refunds, and withdrawals to the account holder\'s own wallet. Players cannot send value to one another. The narrow permitted uses support classification as a competition settlement facility. ChessBets does not claim redeemable cryptocurrencies become legally "closed-loop" merely by adopting internal restrictions.')}
    ${qa('A percentage fee is consideration for transmission.',
      'A percentage-based service fee does not establish what product is sold. Many service providers charge variable fees tied to transaction size without becoming regulated remitters. ChessBets charges for administering its competition service; value movement follows from the competition\'s rules, not a freestanding agreement to transmit value.')}

    <h2>11. Withdrawals, custody and prize entitlement</h2>
    <p>A ChessBets balance may reflect funds available for competition entry, earned prizes, or refundable unused value. ChessBets' position is that these categories arise from its own contractual administration of chess competitions. The company's obligation to pay a prize exists because a player satisfied published competitive conditions; it is not an instruction from the losing player to send cryptocurrency to the winner.</p>
    ${qa('In economic terms the loser\'s contribution funds the winner, so the platform is a transfer intermediary.',
      'Competition economics and legal obligation are distinct concepts. Prize obligations may be funded from admission revenue while still being obligations of the organizer. The legal relationship is defined by the operative agreements, disclosed rules, control over adjudication, and who owes the prize, not merely by the source of aggregate cash receipts.')}

    <h2>12. Transparent fees and fixed competition rules</h2>
    <p>Before joining a queue, a ChessBets player sees the entry fee and the prize the winner receives. The service fee, the amount returned on a draw, and the rules for disconnections, abandonment and cancellation are published in the lobby and in the <a href="/terms">Terms</a>, and apply uniformly to every player. ChessBets' legal position is strengthened by transparent, uniform, enforceable rules that make its competitive product real rather than nominal.</p>
    ${qa('A rake based on the total entry payments is traditionally associated with gambling operations.',
      'Fee structure is evidence to consider, but it cannot replace the legal inquiry into the services being sold and the obligations being performed. ChessBets applies its fee to competition administration, match services, integrity monitoring, and settlement of competition obligations.')}

    <h2>13. No betting on third-party games</h2>
    <p>ChessBets distinguishes its product from sportsbooks and prediction markets by requiring participants to play the actual chess game. It does not quote odds on professional matches, host spectator betting markets, or let customers speculate on who will win a match in which they do not participate. Live games are not even visible to anyone but the two players. The rules, the players and the game result govern the competition payout.</p>
    ${qa('Self-participation does not prevent a transaction from being a wager.',
      'ChessBets does not claim participation is a universal statutory exemption. It argues that direct participation is a critical structural fact separating the sale of competition entry from the sale of a bet on another person\'s outcome. Combined with skill dominance and genuine service administration, it supports ChessBets\' overall classification.')}

    <h2>14. Geographic legality and lawful participation</h2>
    <p>ChessBets' legal interpretation is that its activities should be judged by the precise competition model and the law applicable to each transaction. Differences among states or countries do not alter the nature of standard chess, but applicable local rules can determine whether a paid contest is permitted. The <a href="/terms">Terms</a> allow players to enter paid competitions only where they are lawful for them, and ChessBets may restrict access from any place.</p>
    ${qa('A company cannot invoke Pennsylvania\'s position while serving players in jurisdictions with different laws.',
      'That is correct as to the scope of any jurisdiction\'s law, but it does not refute the substantive classification argument. Each jurisdiction must determine whether its own rules treat genuine participant-funded skill competitions as permitted contests or prohibited wagering. ChessBets asserts its interpretation where supported by the relevant law, not that one jurisdiction governs all others.')}

    <h2>15. Regulatory status, legitimate purpose and consumer confidence</h2>
    <p>ChessBets' legal position rests on its actual operations: a competitive chess service, bounded account functionality, contractual prize administration, and transparent fees. ChessBets does not hold a government gambling license, money-transmitter license or agency approval, and does not claim one by publishing this statement. Its position is a public statutory interpretation, intended to describe the platform accurately and explain why its competition model differs from conventional wagering and remittance products.</p>

    <h2>16. Player-facing competition principles</h2>
    <p>Games are governed by the standard rules of chess and the match conditions in the <a href="/terms">Terms</a>. Entry fees and prizes are displayed before a player commits. ChessBets' <a href="/fair-play">fair-play framework</a> addresses cheating, engine assistance, collusion, multiple accounts, abandoned games and manipulated results. A player can ask for a result to be reviewed under the published review rules (<a href="/terms">Terms, Section 9</a>); the purpose of review is to enforce the competition contract, not to offer discretionary settlements.</p>
    <p>Deposits, entry fees, prizes, refunds and withdrawals are displayed in the player's transaction history in the wallet. Cryptocurrency confirmation times and network fees are separate from the rules that determine who wins a chess match. Restrictions on withdrawal are disclosed in the Terms and applied consistently.</p>

    <h2>17. How to understand this statement</h2>
    <p>This page presents ChessBets' affirmative interpretation of its competition and balance activities. Courts and regulators apply statutes to actual facts and may reach different conclusions; the publication of a legal position is not itself an exemption, adjudication or regulatory authorization. The decisive proposition advanced here is simple: operating chess competitions and paying prizes under an organizer's own rules is not inherently the same business as accepting outside wagers or selling general-purpose cryptocurrency remittances.</p>

    <h2>Authorities and official texts</h2>
    <ul class="sources">
      ${src('18 Pa.C.S. § 5514, Pool selling and bookmaking', 'https://www.legis.state.pa.us/WU01/LI/LI/CT/HTM/18/00.055.014.000..HTM')}
      ${src('18 Pa.C.S. § 5513, Gambling devices, gambling, etc.', 'https://www.legis.state.pa.us/WU01/LI/LI/CT/HTM/18/00.055.013.000..HTM')}
      ${src('31 U.S.C. § 5362, UIGEA definitions', 'https://www.law.cornell.edu/uscode/text/31/5362')}
      ${src('18 U.S.C. § 1084, Wire Act', 'https://www.law.cornell.edu/uscode/text/18/1084')}
      ${src('31 C.F.R. § 1010.100(ff)(5), Money transmitter definition', 'https://www.law.cornell.edu/cfr/text/31/1010.100')}
      ${src('Pennsylvania Money Transmission Business Licensing Law, as amended by Act 7 of 2025', 'https://www.legis.state.pa.us/WU01/LI/LI/US/HTM/1965/0/0249..HTM')}
      ${src('FinCEN ruling FIN-2014-R004, escrow services', 'https://www.fincen.gov/resources/statutes-regulations/administrative-rulings/application-money-services-business-1')}
    </ul>
  </article>`;
}

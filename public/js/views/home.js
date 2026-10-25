import { api, esc, money, icon, ago, coinIcon, POPULAR } from '../lib.js';
import { store, bus } from '../store.js';

// Lobby: entry points, the queues, how a game pays, and recent results.
export default function home(el) {
  const cfg = store.config;
  const coins = [...new Set(cfg.coins.map((c) => c.label || c.code))];
  const coinNames = cfg.payments === 'crypto' ? cfg.coins.map((c) => (c.stable ? `${c.label} on ${c.network.replace(/ \(.*\)/, '')}` : c.name)).join(' or ') : 'crypto';
  const fee = cfg.withdrawFeeBps / 100;
  const sample = cfg.queues.find((q) => q.key === '10:500') || cfg.queues[0];
  const miniBoard = ['bR', '', 'bB', 'bQ', 'bP', 'bP', '', 'bP', '', 'bN', '', '', '', '', 'wP', 'wN']
    .map((p, i) => `<span class="${(Math.floor(i / 4) + i) % 2 ? 'd' : 'l'}" ${p ? `style="background-image:url(/pieces/${p}.svg)"` : ''}></span>`).join('');

  el.innerHTML = `
    <div class="banners">
      <a class="banner" href="/play">
        <h3>Play a Human</h3>
        <p>Random opponent, real stakes. 3 or 10 minutes for $1, $5 or $10.</p>
        <span class="btn btn-gray btn-sm">Find a game</span>
        <div class="banner-art mini-board">${miniBoard}</div>
      </a>
      <a class="banner" href="/wallet">
        <h3>Deposit in crypto</h3>
        <p>Fund your balance with ${esc(coinNames)}. Withdraw your winnings the same way.</p>
        <span class="btn btn-gray btn-sm">Open wallet</span>
        <div class="banner-art coins">${coins.slice(0, 3).map((c) => coinIcon(c)).join('')}</div>
      </a>
      <a class="banner" href="/fair-play">
        <h3>Fair play, checked every move</h3>
        <p>Every game is analysed. Cheaters lose their balance, and the players they beat can have their wager refunded after review.</p>
        <span class="btn btn-gray btn-sm">How it works</span>
        <div class="banner-art shield">${icon('shield', 'stroke-width="1.4"')}</div>
      </a>
    </div>

    <div class="stats-strip" id="stats" hidden><span hidden><span class="live-dot"></span><b class="num" data-k="online"></b>online</span><span hidden><b class="num" data-k="playing"></b>games in progress</span><span hidden><b class="num" data-k="games24h"></b>games today</span><span hidden><b class="num" data-k="wagered24h"></b>wagered today</span></div>

    <section class="section">
      <div class="section-head"><h2>${icon('users')}Play a Human</h2><a class="btn btn-ghost btn-sm" href="/play">View all</a></div>
      <div class="queue-grid" id="queues"></div>
    </section>

    <section class="section">
      <div class="section-head"><h2>${icon('help')}How it works</h2><a class="btn btn-ghost btn-sm" href="/terms">Full rules</a></div>
      <div class="steps">
        <div class="step"><span class="step-n">1</span><b>Deposit</b><p>Send ${esc(coinNames)} to your wallet address. It shows up in your balance once the network confirms it.</p></div>
        <div class="step"><span class="step-n">2</span><b>Pick a queue</b><p>3 or 10 minutes, for ${cfg.queues.filter((q) => q.tc === cfg.queues[0].tc).map((q) => money(q.stake).replace('.00', '')).join(', ').replace(/, ([^,]*)$/, ' or $1')}. You're paired at random with someone on the same queue. No ratings.</p></div>
        <div class="step"><span class="step-n">3</span><b>Win the pot</b><p>A ${money(sample.stake).replace('.00', '')} game pays the winner ${money(sample.win)} after the ${cfg.rakeBps / 100}% rake. A draw returns ${money(sample.draw)} each. Withdrawals carry a ${fee}% fee.</p></div>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div class="tabs" id="feedTabs">
          <button data-f="all" class="on">All games</button>
          <button data-f="high">High stakes</button>
          ${store.user ? '<button data-f="mine">My games</button>' : ''}
        </div>
      </div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Game</th><th>Player</th><th>Time</th><th class="r">Wager</th><th class="r">Payout</th></tr></thead>
        <tbody id="feed"><tr><td colspan="5"><div class="skel" style="height:20px"></div></td></tr></tbody>
      </table></div>
    </section>`;

  const qEl = el.querySelector('#queues');
  const paintQueues = () => {
    qEl.innerHTML = cfg.queues.map((q) => `
        <a class="qtile" href="/play?tc=${q.tc}&stake=${q.stake}&go=1">
          <div class="qtile-top"><span class="qtile-stake num">${money(q.stake).replace('.00', '')}</span>
            <span class="qtile-tc">${icon(q.tc === 3 ? 'bolt' : 'clock')}${q.tc} min</span></div>
          <div class="qtile-foot"><span>Win <span class="win num">${money(q.win)}</span></span>
            ${POPULAR.has(q.key) ? '<span class="popular">Most popular</span>' : ''}</div>
        </a>`).join('');
  };
  paintQueues();

  let filter = 'all';
  let rows = [];
  const tbody = el.querySelector('#feed');
  const row = (r, fresh) => {
    const name = r.kind === 'bot' ? 'House bot' : 'Human';
    const gameIcon = r.kind === 'bot' ? icon('bot') : icon('users');
    const payout = r.outcome === 'win' ? `<span class="green">${money(r.payout)}</span>` : r.outcome === 'draw' ? `<span class="strong">${money(r.payout)}</span>` : `<span>${money(-r.stake)}</span>`;
    return `<tr class="${fresh ? 'new' : ''}">
      <td><a class="gamecell rowlink" href="/game/${esc(r.game)}">${gameIcon}${esc(name)}</a></td>
      <td class="strong">${esc(r.user)}</td>
      <td>${r.tc} min · ${ago(r.at)}</td>
      <td class="r num">${money(r.stake)}</td>
      <td class="r num">${payout}</td></tr>`;
  };
  const paintFeed = (freshCount = 0) => {
    tbody.innerHTML = rows.length
      ? rows.map((r, i) => row(r, i < freshCount)).join('')
      : `<tr><td colspan="5"><div class="empty">${filter === 'mine' ? 'You have not finished a game yet.' : 'No finished games yet. Be the first.'}</div></td></tr>`;
  };
  async function loadFeed() {
    try {
      if (filter === 'mine') {
        const r = await api('/api/my/games');
        rows = r.games.filter((g) => g.outcome !== 'aborted').slice(0, 20).map((g) => ({ game: g.id, user: store.user.username, kind: g.kind, tc: g.tc, stake: g.stake, payout: g.payout, outcome: g.outcome, at: g.at }));
      } else {
        rows = (await api(`/api/feed?f=${filter}`)).rows;
      }
      paintFeed();
    } catch { tbody.innerHTML = '<tr><td colspan="5"><div class="empty">Could not load games.</div></td></tr>'; }
  }
  el.querySelector('#feedTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    filter = b.dataset.f;
    el.querySelectorAll('#feedTabs button').forEach((x) => x.classList.toggle('on', x === b));
    loadFeed();
  });
  loadFeed();

  const statsEl = el.querySelector('#stats');
  async function loadStats() {
    try {
      const s = await api('/api/stats');
      let any = false;
      for (const k of ['online', 'playing', 'games24h', 'wagered24h']) {
        const b = statsEl.querySelector(`[data-k=${k}]`);
        const show = s[k] != null;
        b.parentElement.hidden = !show;
        if (show) b.textContent = k === 'wagered24h' ? money(s[k]) : s[k].toLocaleString('en-US');
        any ||= show;
      }
      statsEl.hidden = !any;
    } catch {}
  }
  loadStats();
  const statsTimer = setInterval(loadStats, 15_000);

  const offs = [
    bus.on('feed', (m) => {
      const incoming = m.rows.filter((r) => filter === 'all' || (filter === 'high' && r.stake >= 1000) || (filter === 'mine' && r.user === store.user?.username));
      if (!incoming.length) return;
      rows = [...incoming, ...rows].slice(0, 20);
      paintFeed(incoming.length);
    }),
  ];
  // Keep relative times fresh.
  const tick = setInterval(() => paintFeed(), 30_000);
  return () => { offs.forEach((f) => f()); clearInterval(statsTimer); clearInterval(tick); };
}

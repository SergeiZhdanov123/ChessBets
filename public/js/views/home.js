import { api, esc, money, icon, ago } from '../lib.js';
import { store, bus } from '../store.js';
import { botAvatar } from '../avatars.js';

// Lobby: entry points, live queue counts, the bots, and recent results.
export default function home(el) {
  const cfg = store.config;
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
      <a class="banner" href="/bots">
        <h3>Play a Bot</h3>
        <p>Thirty minutes against Hikaru, Magnus or Kasparov. Beat one and the house pays double.</p>
        <span class="btn btn-gray btn-sm">Choose a bot</span>
        <div class="banner-art faces">${['hikaru', 'magnus', 'kasparov'].map((b) => `<div class="av">${botAvatar(b)}</div>`).join('')}</div>
      </a>
      <a class="banner" href="/fair-play">
        <h3>Fair play, checked every move</h3>
        <p>Every game is analysed. Cheaters lose their balance and the players they beat get their stake back.</p>
        <span class="btn btn-gray btn-sm">How it works</span>
        <div class="banner-art shield">${icon('shield', 'stroke-width="1.4"')}</div>
      </a>
    </div>

    <div class="stats-strip" id="stats"><span><span class="live-dot"></span><b class="num" data-k="online">-</b>online</span><span><b class="num" data-k="playing">-</b>games in progress</span><span><b class="num" data-k="games24h">-</b>games today</span><span><b class="num" data-k="wagered24h">-</b>wagered today</span></div>

    <section class="section">
      <div class="section-head"><h2>${icon('users')}Play a Human</h2><a class="btn btn-ghost btn-sm" href="/play">View all</a></div>
      <div class="queue-grid" id="queues"></div>
    </section>

    <section class="section">
      <div class="section-head"><h2>${icon('bot')}Play a Bot</h2><a class="btn btn-ghost btn-sm" href="/bots">View all</a></div>
      <div class="bot-row">
        ${cfg.bots.map((b) => `
          <a class="bot-card" href="/bots/${b.id}">
            <div class="art">${botAvatar(b.id, { wide: true })}</div>
            <div class="label"><b>${esc(b.name)}</b><span>${esc(b.style)} · 30 min</span></div>
          </a>`).join('')}
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
    qEl.innerHTML = cfg.queues.map((q) => {
      const n = store.counts?.[q.key] || 0;
      return `
        <a class="qtile" href="/play?tc=${q.tc}&stake=${q.stake}&go=1">
          <div class="qtile-top"><span class="qtile-stake num">${money(q.stake).replace('.00', '')}</span>
            <span class="qtile-tc">${icon(q.tc === 3 ? 'bolt' : 'clock')}${q.tc} min</span></div>
          <div class="qtile-foot"><span>Win <span class="win num">${money(q.win)}</span></span>
            <span class="waiting ${n ? 'some' : ''}"><i></i>${n} waiting</span></div>
        </a>`;
    }).join('');
  };
  paintQueues();

  let filter = 'all';
  let rows = [];
  const tbody = el.querySelector('#feed');
  const row = (r, fresh) => {
    const name = r.kind === 'bot' ? `${cfg.bots.find((b) => b.id === r.bot)?.name || 'Bot'} bot` : 'Human';
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
        rows = r.games.filter((g) => g.outcome !== 'aborted').slice(0, 20).map((g) => ({ game: g.id, user: store.user.username, kind: g.kind, tc: g.tc, bot: g.bot, stake: g.stake, payout: g.payout, outcome: g.outcome, at: g.at }));
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
      for (const k of ['online', 'playing', 'games24h']) statsEl.querySelector(`[data-k=${k}]`).textContent = s[k].toLocaleString('en-US');
      statsEl.querySelector('[data-k=wagered24h]').textContent = money(s.wagered24h);
    } catch {}
  }
  loadStats();
  const statsTimer = setInterval(loadStats, 15_000);

  const offs = [
    bus.on('store', (p) => { if ('counts' in p) paintQueues(); }),
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

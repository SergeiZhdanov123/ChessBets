import { api, esc, money, icon, dateTime } from '../lib.js';
import { store } from '../store.js';

// Admin > Analytics: how visitors move from landing to depositing and
// playing, built by src/analytics.js.

const RANGES = [[1, 'Today'], [7, '7 days'], [30, '30 days'], [90, '90 days']];
const STAGE = {
  signed_up: 'Signed up only', wallet: 'Opened wallet', deposited: 'Deposited', played: 'Played', regular: '5+ games',
};
const PAGE = {
  '/': 'Lobby', '/play': 'Play a Human', '/game/:id': 'Game', '/games': 'My Games', '/fair-play': 'Fair Play',
  '/terms': 'Terms', '/privacy': 'Privacy', '/legal': 'Legal Basis', '/support': 'Support',
  '/register': 'Sign-up form (link)', '/login': 'Sign-in form (link)', '/wallet': 'Wallet (link)',
};
const pageName = (p) => (p ? PAGE[p] || p : '-');
const pct = (a, b) => (b ? `${(Math.round((a / b) * 1000) / 10).toLocaleString('en-US')}%` : '-');
const n = (x) => Number(x || 0).toLocaleString('en-US');
const shortDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

let days = 30;
try { days = +sessionStorage.getItem('cb-an-days') || 30; } catch {}

export default function analytics(el) {
  if (!store.user?.isAdmin) { el.innerHTML = '<div class="empty" style="padding:80px 0">Not found</div>'; return; }
  el.innerHTML = `
    <a class="btn btn-ghost btn-sm" href="/admin" style="margin-bottom:10px">${icon('prev')}Admin</a>
    <div class="admin-top">
      <h1 class="page-title">${icon('chart')}Analytics</h1>
      <div class="seg an-range">${RANGES.map(([d, l]) => `<button data-d="${d}">${l}</button>`).join('')}</div>
    </div>
    <div id="an"><div class="skel" style="height:420px"></div></div>
    <div class="viz-tip" hidden></div>`;
  const box = el.querySelector('#an');
  const tip = el.querySelector('.viz-tip');
  let stage = 'all';
  let token = 0;

  async function load() {
    el.querySelectorAll('.an-range button').forEach((b) => b.classList.toggle('on', +b.dataset.d === days));
    const mine = ++token;
    let a;
    try { a = await api(`/api/admin/analytics?days=${days}`); }
    catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    if (mine !== token) return;
    draw(a);
  }

  function draw(a) {
    const f = Object.fromEntries(a.funnel.map((s) => [s.key, s.n]));
    const since = Date.parse(`${a.from}T00:00:00Z`);
    const partial = !a.trackingSince || a.trackingSince > since;
    box.innerHTML = `
      <p class="fine an-sub">${a.days === 1 ? `Today, ${shortDay(a.to)}` : `${shortDay(a.from)} to ${shortDay(a.to)}`} (UTC days). Admins' browsers are left out.</p>
      ${partial ? `<div class="callout blue">Page views, clicks and sign-up form opens are recorded from ${a.trackingSince ? dateTime(a.trackingSince) : 'now on'}, so those numbers only cover part of this range. Visitors, accounts, deposits and games go back further.</div>` : ''}

      <div class="kpis">
        <div class="kpi"><span>Visitors</span><b>${n(f.visited)}</b><span>unique browsers</span></div>
        <div class="kpi"><span>Visitor to sign-up</span><b>${pct(f.signed_up, f.visited)}</b><span>${n(f.signed_up)} new account${f.signed_up === 1 ? '' : 's'}</span></div>
        <div class="kpi"><span>Sign-up to deposit</span><b>${pct(f.deposited, f.signed_up)}</b><span>${n(f.deposited)} of them deposited</span></div>
        <div class="kpi"><span>Visitor to depositor</span><b>${pct(f.deposited, f.visited)}</b><span>average first deposit ${money(a.money.avgFirst)}</span></div>
        <div class="kpi"><span>Deposited</span><b>${money(a.money.total)}</b><span>${n(a.money.deposits)} deposit${a.money.deposits === 1 ? '' : 's'} by ${n(a.money.depositors)} player${a.money.depositors === 1 ? '' : 's'}</span></div>
      </div>

      <div class="card card-pad an-card">
        <h3>Sign-up funnel</h3>
        <p class="fine">How far people got. The first two steps count browsers; the rest count accounts created in this range, whatever day they went on to deposit or play.</p>
        <div class="funnel">${funnelRows(a.funnel)}</div>
      </div>

      <div class="an-grid3">
        ${trend('Visitors', a.daily, 'visitors')}
        ${trend('New accounts', a.daily, 'signups')}
        ${trend('First deposits', a.daily, 'firstDeposits')}
      </div>
      <details class="an-details"><summary>Day by day as a table</summary>
        <div class="table-wrap"><table class="table"><thead><tr><th>Day</th><th class="r">Visitors</th><th class="r">New accounts</th><th class="r">Sign-up rate</th><th class="r">First deposits</th></tr></thead><tbody>
          ${a.daily.slice().reverse().map((d) => `<tr><td>${shortDay(d.day)}</td><td class="r num">${n(d.visitors)}</td><td class="r num">${n(d.signups)}</td><td class="r num">${pct(d.signups, d.visitors)}</td><td class="r num">${n(d.firstDeposits)}</td></tr>`).join('')}
        </tbody></table></div>
      </details>

      <div class="an-grid2">
        <div class="card card-pad an-card">
          <h3>Visits</h3>
          <p class="fine">A visit is one browser tab session.</p>
          <div class="an-mini">
            <div><span>Visits</span><b>${n(a.visits.count)}</b></div>
            <div><span>Pages per visit</span><b>${a.visits.pagesPer.toFixed(1)}</b></div>
            <div title="Saw one page and clicked nothing"><span>Left without a click</span><b>${pct(a.visits.bounce, 1)}</b></div>
            <div><span>Typical visit length</span><b>${duration(a.visits.medianMs)}</b></div>
          </div>
          <h4>Pages seen per visit</h4>
          <div class="funnel compact">${barRows(a.visits.depth.map((d) => ({ label: d.label, n: d.n })), a.visits.count, 'visits')}</div>
        </div>
        <div class="card card-pad an-card">
          <h3>Screen size</h3>
          <p class="fine">By the screen each browser last used.</p>
          <table class="table"><thead><tr><th></th><th class="r">Visitors</th><th class="r">Accounts</th><th class="r">Sign-up rate</th><th class="r">Depositors</th></tr></thead><tbody>
            ${a.screen.map((s) => `<tr><td class="strong">${s.label}</td><td class="r num">${n(s.visitors)}</td><td class="r num">${n(s.signups)}</td><td class="r num">${pct(s.signups, s.visitors)}</td><td class="r num">${n(s.depositors)}</td></tr>`).join('')}
          </tbody></table>
          <h3 style="margin-top:22px">Where visitors came from</h3>
          <p class="fine">The referring site or ?utm_source= on a browser's first visit in this range. Direct means typed in or bookmarked.</p>
          ${a.sources.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Source</th><th class="r">Visitors</th><th class="r">Accounts</th><th class="r">Sign-up rate</th><th class="r">Depositors</th></tr></thead><tbody>
            ${a.sources.map((s) => `<tr><td class="strong">${esc(s.source)}</td><td class="r num">${n(s.visitors)}</td><td class="r num">${n(s.signups)}</td><td class="r num">${pct(s.signups, s.visitors)}</td><td class="r num">${n(s.depositors)}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">Nothing recorded yet.</div>'}
        </div>
      </div>

      <div class="an-grid2">
        <div class="card card-pad an-card">
          <h3>Where visitors left</h3>
          <p class="fine">The last page of each visit. A high share leaving from one page points at where people give up.</p>
          ${a.pages.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Page</th><th class="r">Views</th><th class="r">Visitors</th><th class="r">Left here</th><th class="r">Exit rate</th></tr></thead><tbody>
            ${a.pages.map((p) => `<tr><td class="strong">${esc(pageName(p.key))}</td><td class="r num">${n(p.n)}</td><td class="r num">${n(p.people)}</td><td class="r num">${n(p.exits)}</td><td class="r num">${pct(p.exits, p.n)}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">Nothing recorded yet.</div>'}
        </div>
        <div class="card card-pad an-card">
          <h3>What people clicked</h3>
          <p class="fine">Buttons and links, by their label. Admin pages aren't recorded.</p>
          ${a.clicks.length ? `<div class="table-wrap an-scroll"><table class="table"><thead><tr><th>Clicked</th><th>On</th><th class="r">Clicks</th><th class="r">People</th></tr></thead><tbody>
            ${a.clicks.map((c) => `<tr><td class="strong an-label" title="${esc(c.label)}">${esc(c.label)}</td><td>${esc(pageName(c.path))}</td><td class="r num">${n(c.n)}</td><td class="r num">${n(c.people)}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">Nothing recorded yet.</div>'}
        </div>
      </div>

      <div class="card card-pad an-card">
        <h3>New accounts and how far they got</h3>
        <p class="fine">Accounts created in this range, newest first.</p>
        <div class="an-stages">${[['all', 'All', a.players.length], ...Object.entries(STAGE).map(([k, l]) => [k, l, a.players.filter((p) => p.stage === k).length])]
          .map(([k, l, c]) => `<button class="${stage === k ? 'on' : ''}" data-stage="${k}">${l} <span>${c}</span></button>`).join('')}</div>
        <div class="table-wrap players-wrap"><table class="table"><thead><tr><th>Player</th><th>Joined</th><th>Got to</th><th class="r">Deposited</th><th class="r">Games</th><th>Source</th><th>Screen</th><th>Last sign-in</th></tr></thead>
          <tbody id="an-players"></tbody></table></div>
      </div>`;

    const showPlayers = () => {
      const rows = stage === 'all' ? a.players : a.players.filter((p) => p.stage === stage);
      box.querySelector('#an-players').innerHTML = rows.length ? rows.map((p) => `<tr>
        <td><a class="rowlink strong" href="/admin/${p.id}">${esc(p.username)}</a>${p.status === 'suspended' ? ' <span class="red">suspended</span>' : ''}</td>
        <td>${dateTime(p.createdAt)}</td>
        <td><span class="an-stage s-${p.stage}">${STAGE[p.stage]}</span></td>
        <td class="r num">${p.deposited ? money(p.deposited) : '-'}</td><td class="r num">${p.games || '-'}</td>
        <td>${esc(p.source || '-')}</td><td>${p.mobile == null ? '-' : p.mobile ? 'Phone' : 'Computer'}</td>
        <td class="dim">${p.lastSeen ? dateTime(p.lastSeen) : '-'}</td></tr>`).join('')
        : '<tr><td colspan="8" class="dim">Nobody here</td></tr>';
    };
    showPlayers();
    box.querySelectorAll('[data-stage]').forEach((b) => (b.onclick = () => {
      stage = b.dataset.stage;
      box.querySelectorAll('[data-stage]').forEach((x) => x.classList.toggle('on', x === b));
      showPlayers();
    }));
  }

  el.querySelectorAll('.an-range button').forEach((b) => (b.onclick = () => {
    days = +b.dataset.d;
    try { sessionStorage.setItem('cb-an-days', days); } catch {}
    load();
  }));

  // Hover tooltips for every bar.
  el.addEventListener('pointermove', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) { tip.hidden = true; return; }
    tip.innerHTML = t.dataset.tip;
    tip.hidden = false;
    const w = tip.offsetWidth;
    tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, e.clientX - w / 2))}px`;
    tip.style.top = `${e.clientY - tip.offsetHeight - 12}px`;
  });
  el.addEventListener('pointerleave', () => { tip.hidden = true; });

  load();
}

function funnelRows(steps) {
  const top = steps[0].n || Math.max(...steps.map((s) => s.n), 1);
  return steps.map((s, i) => {
    const prev = i ? steps[i - 1] : null;
    const lost = prev ? Math.max(0, prev.n - s.n) : 0;
    const w = Math.min(100, (s.n / Math.max(top, 1)) * 100);
    const tipText = `<b>${esc(s.label)}</b>${n(s.n)} ${s.unit}${i ? `<br>${pct(s.n, steps[0].n)} of visitors<br>${pct(s.n, prev.n)} of the step before` : ''}`;
    return `<div class="f-row" data-tip="${esc(tipText)}">
      <div class="f-label">${esc(s.label)}</div>
      <div class="f-track"><div class="f-bar" style="width:${w}%"></div></div>
      <div class="f-n num">${n(s.n)}</div>
      <div class="f-pct num">${i ? pct(s.n, steps[0].n) : ''}</div>
      <div class="f-step num">${prev ? `<span>${pct(s.n, prev.n)}</span> of previous${lost ? ` · <span class="dim">${n(lost)} dropped</span>` : ''}` : ''}</div>
    </div>`;
  }).join('');
}

function barRows(rows, total, unit) {
  const max = Math.max(...rows.map((r) => r.n), 1);
  return rows.map((r) => `<div class="f-row" data-tip="${esc(`<b>${esc(r.label)}</b>${n(r.n)} ${unit} (${pct(r.n, total)})`)}">
    <div class="f-label">${esc(r.label)}</div>
    <div class="f-track"><div class="f-bar" style="width:${(r.n / max) * 100}%"></div></div>
    <div class="f-n num">${n(r.n)}</div><div class="f-pct num">${pct(r.n, total)}</div></div>`).join('');
}

function trend(title, daily, key) {
  const max = Math.max(...daily.map((d) => d[key]), 0);
  const total = daily.reduce((s, d) => s + d[key], 0);
  return `<div class="card card-pad an-card trend">
    <div class="trend-head"><h3>${title}</h3><b class="num">${n(total)}</b></div>
    <div class="trend-plot">
      <span class="trend-max num">${n(max)}</span>
      <div class="trend-bars">${daily.map((d) => `<div class="t-col" data-tip="${esc(`<b>${shortDay(d.day)}</b>${n(d[key])} ${title.toLowerCase()}`)}"><i style="height:${max ? Math.max(d[key] ? 3 : 0, (d[key] / max) * 100) : 0}%"></i></div>`).join('')}</div>
    </div>
    <div class="trend-axis fine"><span>${shortDay(daily[0].day)}</span><span>${shortDay(daily.at(-1).day)}</span></div>
  </div>`;
}

function duration(ms) {
  if (!ms) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

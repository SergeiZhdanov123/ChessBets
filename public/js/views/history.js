import { api, esc, money, icon, dateTime, reasonText } from '../lib.js';
import { store } from '../store.js';
import { requireUser } from './auth.js';

export default function historyView(el) {
  el.innerHTML = `<h1 class="page-title">${icon('history')}My Games</h1><div id="h"><div class="skel" style="height:240px"></div></div>`;
  const box = el.querySelector('#h');
  if (!store.user) {
    box.innerHTML = `<div class="card card-pad empty">Sign in to see your games.<div style="margin-top:14px"><button class="btn btn-blue" id="si">Sign In</button></div></div>`;
    box.querySelector('#si').onclick = () => requireUser(() => historyView(el));
    return;
  }
  api('/api/my/games').then(({ games }) => {
    if (!games.length) {
      box.innerHTML = `<div class="card card-pad empty">No games yet.<div style="margin-top:14px;display:flex;gap:8px;justify-content:center"><a class="btn btn-green" href="/play">Play a Human</a></div></div>`;
      return;
    }
    const totals = games.reduce((t, g) => {
      if (g.outcome === 'aborted') return t;
      t.played++;
      t.wagered += g.stake;
      t.net += g.payout - g.stake;
      if (g.outcome === 'win') t.won++;
      return t;
    }, { played: 0, won: 0, wagered: 0, net: 0 });
    box.innerHTML = `
      <div class="kpis">
        <div class="kpi"><span>Games played</span><b>${totals.played}</b></div>
        <div class="kpi"><span>Won</span><b>${totals.won}</b></div>
        <div class="kpi"><span>Entry fees</span><b>${money(totals.wagered)}</b></div>
        <div class="kpi"><span>Net result</span><b class="${totals.net > 0 ? 'green' : ''}">${money(totals.net, { sign: true })}</b></div>
      </div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Game</th><th>Opponent</th><th>Result</th><th>Date</th><th class="r">Entry fee</th><th class="r">Net</th></tr></thead>
        <tbody>${games.map((g) => {
          const net = g.outcome === 'aborted' ? 0 : g.payout - g.stake;
          const res = { win: '<span class="green">Won</span>', loss: 'Lost', draw: 'Draw', aborted: 'Aborted' }[g.outcome];
          return `<tr>
            <td><a class="gamecell rowlink" href="/game/${esc(g.id)}">${icon('users')}Human · ${g.tc} min</a></td>
            <td class="strong">${esc(g.opponent || '-')}</td>
            <td>${res} <span class="dim">${esc(g.outcome === 'aborted' ? '' : reasonText(g.reason))}</span></td>
            <td>${dateTime(g.at)}</td>
            <td class="r num">${money(g.stake)}</td>
            <td class="r num ${net > 0 ? 'green' : ''}">${g.outcome === 'aborted' ? '-' : money(net, { sign: true })}</td></tr>`;
        }).join('')}</tbody>
      </table></div>`;
  }).catch((e) => { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
}

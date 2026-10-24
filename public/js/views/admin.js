import { api, esc, money, icon, toast, dateTime, confirmBox } from '../lib.js';
import { store } from '../store.js';
import { navigate } from '../app.js';

const HOUSE_LABEL = {
  rake: 'Rake', withdraw_fee: 'Withdrawal fees', bot_win: 'Bot games won', bot_loss: 'Bot games lost',
  forfeit: 'Forfeited balances', fairplay_refund: 'Fair-play refunds', reinstated: 'Restored balances',
};

export default function admin(el, [userId]) {
  if (!store.user?.isAdmin) { el.innerHTML = '<div class="empty" style="padding:80px 0">Not found</div>'; return; }
  if (userId) return userPage(el, +userId);
  el.innerHTML = `<h1 class="page-title">${icon('admin')}Admin</h1><div id="a"><div class="skel" style="height:300px"></div></div>`;
  const box = el.querySelector('#a');

  async function load() {
    const [o, t] = await Promise.all([api('/api/admin/overview'), api('/api/admin/tickets')]);
    const house = Object.fromEntries(o.house.map((h) => [h.kind, h]));
    const net = o.house.reduce((s, h) => s + h.total, 0);
    box.innerHTML = `
      <div class="kpis">
        <div class="kpi"><span>House result</span><b class="${net >= 0 ? 'green' : 'red'}">${money(net, { sign: true })}</b></div>
        <div class="kpi"><span>Player balances</span><b>${money(o.totals.balances)}</b></div>
        <div class="kpi"><span>In play now</span><b>${money(o.totals.held)}</b></div>
        <div class="kpi"><span>Users · games</span><b>${o.totals.users} · ${o.totals.games}</b></div>
      </div>
      <div class="card card-pad" style="margin-bottom:18px">
        <h3 style="font-size:15px;margin-bottom:8px">Where the house money came from</h3>
        <table class="table"><tbody>${Object.entries(HOUSE_LABEL).map(([k, label]) => `<tr><td>${label}</td><td class="r num">${house[k]?.n || 0}</td><td class="r num strong">${money(house[k]?.total || 0, { sign: true })}</td></tr>`).join('')}</tbody></table>
      </div>

      <div class="section-head"><h2>${icon('search')}Find a player</h2></div>
      <div style="display:flex;gap:8px;margin-bottom:10px"><input class="input" id="q" placeholder="Username" style="max-width:320px"><button class="btn btn-gray" id="qs">Search</button></div>
      <div id="qr"></div>

      <div class="section-head" style="margin-top:24px"><h2>${icon('shield')}Flagged and suspended</h2></div>
      ${o.flagged.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Player</th><th>Status</th><th>Top game evidence</th><th class="r">Events</th><th class="r">Balance</th></tr></thead><tbody>
        ${o.flagged.map((u) => `<tr><td><a class="rowlink strong" href="/admin/${u.id}">${esc(u.username)}</a></td>
          <td>${u.status === 'suspended' ? '<span class="red">Suspended</span>' : '<span class="status wait">Under review</span>'}</td>
          <td class="num">${u.maxEvidence ?? '-'}</td><td class="r num">${u.events}</td><td class="r num">${money(u.balance)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty card">Nobody is flagged.</div>'}

      <div class="section-head" style="margin-top:24px"><h2>${icon('clock')}Scheduled actions</h2></div>
      ${o.pending.length ? `<table class="table"><tbody>${o.pending.map((a) => `<tr><td><a class="rowlink strong" href="/admin/${a.user_id}">${esc(a.username)}</a></td><td>${esc(a.kind)}</td><td>${esc(JSON.parse(a.payload || '{}')?.reason || '')}</td><td class="r">${dateTime(a.run_at)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty card">Nothing scheduled.</div>'}

      <div class="section-head" style="margin-top:24px"><h2>${icon('help')}Support tickets</h2></div>
      <div id="tk">${t.tickets.length ? '' : '<div class="empty card">No tickets.</div>'}</div>`;

    const tk = box.querySelector('#tk');
    tk.innerHTML += t.tickets.map((x) => `
      <div class="ticket">
        <div class="ticket-head"><b>${esc(x.subject)} <span class="dim">from <a class="rowlink" href="/admin/${x.user_id}">${esc(x.username)}</a>${x.user_status === 'suspended' ? ' (suspended)' : ''}</span></b><span class="status ${x.status === 'open' ? 'wait' : 'ok'}">${esc(x.status)}</span></div>
        ${x.messages.map((m) => `<div class="msg ${m.author}"><div class="meta">${m.author === 'staff' ? 'Staff' : esc(x.username)} · ${dateTime(m.created_at)}</div>${esc(m.body)}</div>`).join('')}
        <div style="display:flex;gap:8px;margin-top:10px"><input class="input" data-r="${x.id}" placeholder="Reply as staff"><button class="btn btn-gray" data-send="${x.id}">Reply</button><button class="btn btn-ghost" data-close="${x.id}">Close</button></div>
      </div>`).join('');
    tk.querySelectorAll('[data-send],[data-close]').forEach((b) => (b.onclick = async () => {
      const tid = b.dataset.send || b.dataset.close;
      const body = tk.querySelector(`[data-r="${tid}"]`).value;
      await api(`/api/admin/tickets/${tid}/reply`, { body, close: !!b.dataset.close });
      load();
    }));
    const search = async () => {
      const { users } = await api(`/api/admin/users?q=${encodeURIComponent(box.querySelector('#q').value)}`);
      box.querySelector('#qr').innerHTML = users.length ? `<table class="table"><tbody>${users.map((u) => `<tr><td><a class="rowlink strong" href="/admin/${u.id}">${esc(u.username)}</a></td><td>${esc(u.status)}${u.review ? ' · review' : ''}</td><td class="r num">${money(u.balance)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No match</div>';
    };
    box.querySelector('#qs').onclick = search;
    box.querySelector('#q').onkeydown = (e) => { if (e.key === 'Enter') search(); };
  }
  load().catch((e) => { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
}

async function userPage(el, id) {
  el.innerHTML = '<div class="skel" style="height:300px"></div>';
  let d;
  try { d = await api(`/api/admin/users/${id}`); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const u = d.user;
  el.innerHTML = `
    <a class="btn btn-ghost btn-sm" href="/admin" style="margin-bottom:10px">${icon('prev')}Admin</a>
    <h1 class="page-title">${esc(u.username)} <span class="dim" style="font-size:14px;font-weight:600">#${u.id}</span></h1>
    <div class="kpis">
      <div class="kpi"><span>Status</span><b class="${u.status === 'suspended' ? 'red' : ''}">${u.status === 'suspended' ? 'Suspended' : u.review ? 'Under review' : 'Active'}</b></div>
      <div class="kpi"><span>Balance</span><b>${money(u.balance)}</b></div>
      <div class="kpi"><span>Account evidence</span><b>${d.account.evidence}</b></div>
      <div class="kpi"><span>Games analysed</span><b>${d.account.games}</b></div>
    </div>
    ${u.status === 'suspended' ? `<div class="callout red">Suspended ${dateTime(u.suspended_at)}: ${esc(u.suspend_reason || '')}. Forfeited ${money(u.forfeited)}.</div>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:22px">
      ${u.status === 'suspended'
        ? `<button class="btn btn-green" data-act="reinstate-restore">Reinstate and restore ${money(u.forfeited)}</button><button class="btn btn-gray" data-act="reinstate">Reinstate without balance</button>`
        : `<button class="btn btn-red" data-act="suspend">Suspend</button>${u.review ? '<button class="btn btn-gray" data-act="clear">Clear review</button>' : ''}`}
    </div>

    <div class="section-head"><h2>${icon('shield')}Game reports</h2></div>
    ${d.reports.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Game</th><th>Verdict</th><th class="r">Evidence</th><th class="r">Engine-level</th><th class="r">Hard moves</th><th class="r">Avg loss</th><th class="r">Time CV</th><th class="r">Tab away</th></tr></thead><tbody>
      ${d.reports.map((r) => { const m = r.metrics; return `<tr title="${esc(m.summary || '')}">
        <td><a class="rowlink" href="/game/${esc(r.game_id)}">${esc(r.game_id)}</a></td>
        <td><span class="verdict ${esc(r.verdict)}">${esc(r.verdict)}</span></td>
        <td class="r num">${r.evidence}</td>
        <td class="r num">${m.near}/${m.nonTrivial}</td>
        <td class="r num">${m.found}/${m.critical}</td>
        <td class="r num">${m.acpl ?? '-'}</td>
        <td class="r num">${m.timeCv ?? '-'}</td>
        <td class="r num">${Math.round((m.blurRate || 0) * 100)}%</td></tr>`; }).join('')}
    </tbody></table></div>` : '<div class="empty card">No analysed games.</div>'}

    <div class="section-head" style="margin-top:24px"><h2>${icon('list')}Events</h2></div>
    ${d.events.length ? `<table class="table"><tbody>${d.events.map((e) => `<tr><td class="strong">${esc(e.kind)}</td><td style="white-space:normal">${esc(e.detail || '')}</td><td>${e.game_id ? `<a class="rowlink" href="/game/${esc(e.game_id)}">${esc(e.game_id)}</a>` : ''}</td><td class="r">${dateTime(e.created_at)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty card">No events.</div>'}

    <div class="section-head" style="margin-top:24px"><h2>${icon('lock')}Devices</h2></div>
    <table class="table"><tbody>${d.devices.map((x) => `<tr><td class="num">${esc(x.device_id.slice(0, 12))}...</td><td>${esc(x.ip || '')}</td><td>${x.shared ? `<span class="status wait">Shared with ${esc(x.shared)}</span>` : 'Not shared'}</td><td class="r">${dateTime(x.last_seen)}</td></tr>`).join('') || '<tr><td>None</td></tr>'}</tbody></table>

    <div class="section-head" style="margin-top:24px"><h2>${icon('wallet')}Ledger</h2></div>
    <table class="table"><tbody>${d.ledger.map((x) => `<tr><td class="strong">${esc(x.kind)}</td><td>${esc(x.note || x.ref || '')}</td><td class="r num ${x.amount > 0 ? 'green' : ''}">${money(x.amount, { sign: true })}</td><td class="r num">${money(x.balance_after)}</td><td class="r">${dateTime(x.created_at)}</td></tr>`).join('')}</tbody></table>`;

  el.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async () => {
    const a = b.dataset.act;
    try {
      if (a === 'suspend') {
        if (!(await confirmBox(`Suspend ${u.username}?`, `Their ${money(u.balance)} balance is forfeited and opponents they beat this week are refunded.`, { ok: 'Suspend', danger: true }))) return;
        await api(`/api/admin/users/${id}/suspend`, { reason: 'Suspended by staff after review' });
      }
      if (a === 'clear') await api(`/api/admin/users/${id}/clear-review`, {});
      if (a === 'reinstate') await api(`/api/admin/users/${id}/reinstate`, { restore: false });
      if (a === 'reinstate-restore') await api(`/api/admin/users/${id}/reinstate`, { restore: true });
      toast('Done', { kind: 'ok', ms: 2000 });
      navigate(`/admin/${id}`, { replace: true });
    } catch (e) { toast(e.message, { kind: 'bad' }); }
  }));
}

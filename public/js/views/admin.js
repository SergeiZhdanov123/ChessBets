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
    const [o, t, pay] = await Promise.all([api('/api/admin/overview'), api('/api/admin/tickets'), api('/api/admin/payments')]);
    const house = Object.fromEntries(o.house.map((h) => [h.kind, h]));
    const net = o.house.reduce((s, h) => s + h.total, 0);
    box.innerHTML = `
      <div class="kpis">
        <div class="kpi"><span>House result</span><b class="${net >= 0 ? 'green' : 'red'}">${money(net, { sign: true })}</b></div>
        <div class="kpi"><span>Player balances</span><b>${money(o.totals.balances)}</b></div>
        <div class="kpi"><span>In play now</span><b>${money(o.totals.held)}</b></div>
        <div class="kpi"><span>Users · games</span><b>${o.totals.users} · ${o.totals.games}</b></div>
        <div class="kpi" title="One per browser per UTC day. Admins and script-less crawlers aren't counted."><span>Unique visitors today</span><b>${o.visitors.today.toLocaleString('en-US')}</b><span>${o.visitors.yesterday.toLocaleString('en-US')} yesterday · ${o.visitors.week.toLocaleString('en-US')} in 7 days</span></div>
      </div>
      <div class="card card-pad" style="margin-bottom:18px">
        <h3 style="font-size:15px;margin-bottom:8px">Where the house money came from</h3>
        <table class="table"><tbody>${Object.entries(HOUSE_LABEL).filter(([k]) => !k.startsWith('bot_') || house[k]).map(([k, label]) => `<tr><td>${label}</td><td class="r num">${house[k]?.n || 0}</td><td class="r num strong">${money(house[k]?.total || 0, { sign: true })}</td></tr>`).join('')}</tbody></table>
      </div>

      ${pay.mode === 'crypto' ? paymentsHtml(pay) : ''}

      <div class="section-head"><h2>${icon('search')}Find a player</h2></div>
      <div style="display:flex;gap:8px;margin-bottom:10px"><input class="input" id="q" placeholder="Username" style="max-width:320px"><button class="btn btn-gray" id="qs">Search</button></div>
      <div id="qr"></div>

      <div class="section-head" style="margin-top:24px"><h2>${icon('shield')}Flagged and suspended</h2></div>
      ${o.flagged.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Player</th><th>Status</th><th>Top game evidence</th><th class="r">Events</th><th class="r">Balance</th></tr></thead><tbody>
        ${o.flagged.map((u) => `<tr><td><a class="rowlink strong" href="/admin/${u.id}">${esc(u.username)}</a></td>
          <td>${u.status === 'suspended' ? '<span class="red">Suspended</span>' : '<span class="status wait">Under review</span>'}</td>
          <td class="num">${u.maxEvidence ?? '-'}</td><td class="r num">${u.events}</td><td class="r num">${money(u.balance)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty card">Nobody is flagged.</div>'}

      <div class="section-head" style="margin-top:24px"><h2>${icon('wallet')}Fair-play refunds to approve <span class="dim">${o.refunds.length}</span></h2></div>
      ${o.refunds.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Player</th><th>Lost to</th><th>Game</th><th class="r">Refund</th><th>Requested</th><th></th></tr></thead><tbody>
        ${o.refunds.map((r) => `<tr>
          <td><a class="rowlink strong" href="/admin/${r.user_id}">${esc(r.username || '?')}</a></td>
          <td><a class="rowlink" href="/admin/${r.cheater_id}">${esc(r.cheater || '?')}</a></td>
          <td><a class="rowlink num" href="/game/${esc(r.game_id)}">${esc(String(r.game_id).slice(0, 8))}</a></td>
          <td class="r num strong">${money(r.amount)}</td><td>${dateTime(r.created_at)}</td>
          <td><div style="display:flex;gap:6px;justify-content:flex-end"><button class="btn btn-green btn-sm" data-refund="${r.id}" data-d="approve">Approve</button><button class="btn btn-ghost btn-sm" data-refund="${r.id}" data-d="decline">Decline</button></div></td>
        </tr>`).join('')}
      </tbody></table></div>` : '<div class="empty card">No refunds waiting.</div>'}

      <div class="section-head" style="margin-top:24px"><h2>${icon('clock')}Scheduled actions</h2></div>
      ${o.pending.length ? `<table class="table"><tbody>${o.pending.map((a) => `<tr><td><a class="rowlink strong" href="/admin/${a.user_id}">${esc(a.username)}</a></td><td>${esc(a.kind)}</td><td>${esc((typeof a.payload === 'string' ? JSON.parse(a.payload || '{}') : a.payload)?.reason || '')}</td><td class="r">${dateTime(a.run_at)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty card">Nothing scheduled.</div>'}

      <div class="section-head" style="margin-top:24px"><h2>${icon('help')}Support tickets</h2></div>
      <div id="tk">${t.tickets.length ? '' : '<div class="empty card">No tickets.</div>'}</div>`;

    if (pay.mode === 'crypto') wirePayments(box, load);
    box.querySelectorAll('[data-refund]').forEach((b) => (b.onclick = async () => {
      const approve = b.dataset.d === 'approve';
      const row = o.refunds.find((r) => String(r.id) === b.dataset.refund);
      if (!(await confirmBox(approve ? `Refund ${money(row.amount)} to ${row.username}?` : 'Decline this refund?',
        approve ? 'Their stake from this game goes back to their balance.' : 'Nothing is paid. You can still credit them by hand later.',
        { ok: approve ? 'Approve' : 'Decline', danger: !approve }))) return;
      try { await api(`/api/admin/refunds/${b.dataset.refund}/${b.dataset.d}`, {}); toast(approve ? 'Refund paid' : 'Refund declined', { kind: 'ok', ms: 2000 }); load(); }
      catch (e) { toast(e.message, { kind: 'bad' }); }
    }));
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

const PAY_STATUS = { unmatched: 'Not matched', held: 'On hold' };

function paymentsHtml(p) {
  const w = p.wallets;
  const b = w.btc;
  return `
    <div class="section-head"><h2>${icon('wallet')}Payments</h2></div>
    <div class="card card-pad" style="margin-bottom:18px">
      <table class="table"><tbody>
        ${b ? `<tr><td class="strong">Bitcoin ${b.network === 'main' ? '' : '(testnet)'}</td><td class="num">${esc(b.xpub)}</td><td>${b.assigned} address${b.assigned === 1 ? '' : 'es'} given out</td></tr>
          <tr><td>First address</td><td class="num" style="word-break:break-all;white-space:normal">${esc(b.firstAddress)}</td><td class="dim" style="white-space:normal">Must match the first receiving address in your wallet app${b.firstIndex ? ` (index ${b.firstIndex})` : ''}</td></tr>` : ''}
        ${w.tron ? `<tr><td class="strong">USDT on Tron</td><td class="num" style="word-break:break-all;white-space:normal">${esc(w.tron.address)}</td><td></td></tr>` : ''}
        <tr><td>Last check of the chain</td><td>${w.lastScan ? dateTime(w.lastScan) : 'not yet'}</td><td>${w.price ? `BTC ${money(Math.round(w.price * 100))}` : ''}</td></tr>
      </tbody></table>
      ${w.lastError ? `<div class="callout red">Last check failed: ${esc(w.lastError)}</div>` : ''}
      ${b && b.gap >= 15 ? `<div class="callout">${b.gap} bitcoin addresses past the last one that received money. Wallet apps stop looking 20 addresses past the last used one, so coins sent there won't show in your wallet until it generates that many addresses. In Electrum: View > Show Console, then type <span class="num">[wallet.create_new_address(False) for i in range(${Math.ceil((b.gap + 10) / 10) * 10})]</span>.</div>` : ''}
    </div>

    <h3 style="font-size:15px;margin:0 0 8px">Withdrawals to send <span class="dim">${p.withdrawals.length}</span></h3>
    ${p.withdrawals.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Player</th><th class="r">Send</th><th>To</th><th>Requested</th><th></th></tr></thead><tbody>
      ${p.withdrawals.map((w) => `<tr>
        <td class="num">${w.id}</td>
        <td><a class="rowlink strong" href="/admin/${w.user_id}">${esc(w.username || '?')}</a>${w.status === 'review' || w.user_review ? ' <span class="status wait">review</span>' : ''}</td>
        <td class="r num"><b>${money(w.net)}</b><div class="dim">${w.coin_now ? `about ${esc(w.coin_now)} ${esc(w.label)}` : esc(w.label)}</div></td>
        <td style="white-space:normal;max-width:260px"><div class="dim">${esc(w.network || '')}</div><span class="num" style="word-break:break-all">${esc(w.address)}</span> <button class="btn btn-ghost btn-sm" data-copy="${esc(w.address)}">${icon('copy')}</button></td>
        <td>${dateTime(w.created_at)}</td>
        <td style="min-width:260px"><div style="display:flex;gap:6px"><input class="input" data-txid="${w.id}" placeholder="txid after sending" style="height:36px"><button class="btn btn-green btn-sm" data-sent="${w.id}">Mark sent</button><button class="btn btn-ghost btn-sm" data-decline="${w.id}" data-amt="${w.amount}" data-user="${esc(w.username || '')}">Decline</button></div></td>
      </tr>`).join('')}
    </tbody></table></div>` : '<div class="empty card" style="margin-bottom:18px">Nothing to send.</div>'}

    ${p.problems.length ? `<h3 style="font-size:15px;margin:18px 0 8px">Payments that need a person</h3>
    <div class="table-wrap"><table class="table"><thead><tr><th>Transaction</th><th>Coin</th><th class="r">Amount</th><th>Status</th><th>Player</th><th>Seen</th></tr></thead><tbody>
      ${p.problems.map((x) => `<tr title="${esc(x.note || '')}">
        <td class="num" style="word-break:break-all;white-space:normal;max-width:220px">${esc(x.id)}</td><td>${esc(x.coin || '')}</td><td class="r num">${esc(x.sum || '')}</td>
        <td><span class="status ${x.status === 'pending' ? 'wait' : 'bad'}">${PAY_STATUS[x.status] || esc(x.status)}</span>${x.note ? `<div class="dim" style="white-space:normal">${esc(x.note)}</div>` : ''}</td>
        <td>${x.user_id ? `<a class="rowlink" href="/admin/${x.user_id}">${esc(x.username || '?')}</a>` : ''}</td><td>${dateTime(x.first_seen)}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="fine" style="margin:6px 0 0">To credit one of these, open the player and use Credit a deposit with the transaction id.</p>` : ''}

    <h3 style="font-size:15px;margin:18px 0 8px">Recent deposits</h3>
    ${p.deposits.length ? `<div class="table-wrap"><table class="table"><tbody>${p.deposits.map((d) => `<tr>
      <td class="num">${d.id}</td><td><a class="rowlink strong" href="/admin/${d.user_id}">${esc(d.username || '?')}</a></td>
      <td class="r num">${money(d.status === 'credited' ? d.credited : d.amount)}</td><td class="num">${d.coin_amount ? `${esc(d.coin_amount)} ${esc(d.label || '')}` : esc(d.kind === 'manual' ? 'by staff' : '')}</td>
      <td>${esc(d.status)}</td><td class="r">${dateTime(d.created_at)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty card">No deposits yet.</div>'}
    <div style="height:10px"></div>`;
}

function wirePayments(box, reload) {
  box.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); } catch {}
    b.innerHTML = icon('check');
  }));
  box.querySelectorAll('[data-sent]').forEach((b) => (b.onclick = async () => {
    const id = b.dataset.sent;
    const txid = box.querySelector(`[data-txid="${id}"]`).value.trim();
    if (!txid) return toast('Send the payment first, then paste its transaction id', { kind: 'bad' });
    b.disabled = true;
    try { await api(`/api/admin/withdrawals/${id}/sent`, { txid }); toast('Marked as sent', { kind: 'ok', ms: 2000 }); reload(); }
    catch (e) { toast(e.message, { kind: 'bad' }); b.disabled = false; }
  }));
  box.querySelectorAll('[data-decline]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox('Decline this withdrawal?', `${money(+b.dataset.amt)}, fee included, goes back to ${b.dataset.user}'s balance.`, { ok: 'Decline', danger: true }))) return;
    try { await api(`/api/admin/withdrawals/${b.dataset.decline}/reject`, { note: 'Declined by staff. Contact support for details.' }); reload(); }
    catch (e) { toast(e.message, { kind: 'bad' }); }
  }));
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

    ${store.config?.payments === 'crypto' && u.status !== 'suspended' ? `
    <div class="section-head"><h2>${icon('wallet')}Credit a deposit</h2></div>
    <div class="card card-pad" style="margin-bottom:22px">
      <p class="fine" style="margin-bottom:10px">For a payment that reached our wallet but wasn't matched, for example a short amount after an exchange fee. Check it on a block explorer first. Each transaction id can be credited once.</p>
      <div style="display:grid;grid-template-columns:140px 1fr;gap:8px;margin-bottom:8px">
        <div class="input-wrap"><span class="input-suffix">$</span><input class="input" id="mc-amt" inputmode="decimal" placeholder="0.00"></div>
        <input class="input num" id="mc-tx" placeholder="Transaction id" spellcheck="false">
      </div>
      <div style="display:flex;gap:8px"><input class="input" id="mc-note" placeholder="Note shown to the player (optional)"><button class="btn btn-green" id="mc-go">Credit</button></div>
    </div>` : ''}

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

  const mc = el.querySelector('#mc-go');
  if (mc) mc.onclick = async () => {
    const amount = Math.round(Number(el.querySelector('#mc-amt').value.replace(/[^0-9.]/g, '')) * 100);
    const txid = el.querySelector('#mc-tx').value.trim();
    if (!(amount > 0) || !txid) return toast('Enter the amount and the transaction id', { kind: 'bad' });
    if (!(await confirmBox(`Credit ${money(amount)} to ${u.username}?`, `Against transaction ${txid.slice(0, 18)}... This can't be undone from here.`, { ok: 'Credit' }))) return;
    try {
      await api(`/api/admin/users/${id}/credit`, { amount, txid, note: el.querySelector('#mc-note').value.trim() });
      toast('Credited', { kind: 'ok', ms: 2000 });
      navigate(`/admin/${id}`, { replace: true });
    } catch (e) { toast(e.message, { kind: 'bad' }); }
  };

  el.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async () => {
    const a = b.dataset.act;
    try {
      if (a === 'suspend') {
        if (!(await confirmBox(`Suspend ${u.username}?`, `Their ${money(u.balance)} balance is forfeited. Opponents they beat this week are queued for a refund you approve.`, { ok: 'Suspend', danger: true }))) return;
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

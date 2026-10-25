import { api, openModal, money, esc, icon, coinIcon, toast, dateTime, ago } from '../lib.js';
import { store, bus } from '../store.js';

const KIND = {
  deposit: 'Deposit', withdrawal: 'Withdrawal', withdrawal_refund: 'Withdrawal declined', stake: 'Entry fee', stake_return: 'Entry fee returned',
  win: 'Prize', draw: 'Draw refund', forfeit: 'Forfeited', fairplay_refund: 'Fair-play refund', reinstated: 'Balance restored',
};

let state = { tab: 'deposit', coin: null, wcoin: null, data: null, invoice: null };

export function openWallet(tab) {
  if (tab) state.tab = tab;
  const live = store.config?.payments === 'crypto';
  const m = openModal({
    title: 'Wallet', iconName: 'wallet', width: 520, body: '<div class="skel" style="height:260px"></div>',
    foot: live ? '' : 'Paper money. Deposits and withdrawals are simulated and nothing leaves this site.',
    onClose: () => { offs.forEach((f) => f()); clearInterval(tick); clearInterval(look); state.invoice = null; },
  });
  const offs = [
    bus.on('wallet', (msg) => {
      if (state.invoice && msg?.deposit?.id === state.invoice.id) refreshInvoice();
      load(false);
    }),
    bus.on('store', (p) => {
      if (!('user' in p) || !store.user) return;
      const shown = m.body.dataset.status;
      if (shown && shown !== store.user.status) return paint();
      const av = m.body.querySelector('#wd-avail');
      if (av) av.textContent = `Available ${money(store.user.balance)}`;
    }),
  ];
  // Keeps the "expires in" line honest while a payment screen is open.
  const tick = setInterval(() => {
    const el = m.body.querySelector('#inv-left');
    if (el && state.invoice) el.textContent = leftText(state.invoice.expires_at);
  }, 15_000);
  // While someone is looking at a deposit address, ask the server to check
  // the chain every 20 seconds so the payment shows up without a reload.
  const look = setInterval(() => {
    if (live && state.tab === 'deposit' && m.body.querySelector('[data-watching]') && !document.hidden) checkNow(false);
  }, 20_000);

  async function checkNow(manual) {
    const btn = m.body.querySelector('#chk');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking...'; }
    try {
      const r = await api('/api/wallet/refresh', {});
      state.data = { ...state.data, deposits: r.deposits, withdrawals: r.withdrawals, ledger: r.ledger };
      if (r.user) store.set({ user: { ...store.user, ...r.user } });
      if (state.invoice) await refreshInvoice();
      paintLists();
    } catch (e) { if (manual) toast(e.message, { kind: 'bad' }); }
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = 'Check for payment'; }
  }

  async function load(full = true) {
    try {
      state.data = await api('/api/wallet');
      const codes = state.data.coins.map((c) => c.code);
      if (!codes.includes(state.coin)) state.coin = codes[0] || null;
      if (!codes.includes(state.wcoin)) state.wcoin = codes[0] || null;
      if (full) paint(); else paintLists();
    } catch (e) {
      m.body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  function paint() {
    if (!state.data) return;
    const u = store.user;
    if (!u) return;
    m.body.dataset.status = u.status;
    if (u.status === 'suspended') {
      m.body.innerHTML = `
        <div class="callout red">This account is suspended. Its balance was forfeited and is not refundable. Deposits and withdrawals are disabled.</div>
        <a class="btn btn-gray btn-block" href="/support">Contact support</a>
        <h4 style="margin:20px 0 6px">Transactions</h4><div id="wl-tx"></div>`;
      paintLists();
      return;
    }
    m.body.innerHTML = `
      <div class="seg" role="tablist">
        <button data-tab="deposit" class="${state.tab === 'deposit' ? 'on' : ''}">Deposit</button>
        <button data-tab="withdraw" class="${state.tab === 'withdraw' ? 'on' : ''}">Withdraw</button>
        <button data-tab="tx" class="${state.tab === 'tx' ? 'on' : ''}">Transactions</button>
      </div>
      <div id="wl-pane"></div>`;
    m.body.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; state.invoice = null; paint(); }));
    const pane = m.body.querySelector('#wl-pane');
    if (!state.data.coins.length && state.tab !== 'tx') {
      pane.innerHTML = '<div class="empty" style="padding:28px 10px">Crypto payments are unavailable right now. Try again in a few minutes.</div>';
      return;
    }
    if (state.tab === 'deposit') {
      if (!live) depositPane(pane);
      else if (state.invoice) invoicePane(pane);
      else liveDepositPane(pane);
    }
    if (state.tab === 'withdraw') withdrawPane(pane);
    if (state.tab === 'tx') { pane.innerHTML = '<div id="wl-tx"></div>'; paintLists(); }
  }

  function coinGrid(selected, attr) {
    const coins = state.data.coins;
    const dup = (c) => coins.filter((x) => x.label === c.label).length > 1;
    return `<div class="coin-grid">${coins.map((c) => `
      <button class="coin-opt ${c.code === selected ? 'on' : ''}" ${attr}="${c.code}" title="${esc(`${c.name} on ${c.network}`)}">${coinIcon(c.label)}<span>${esc(c.label)}${dup(c) ? `<small>${esc(netTag(c.network))}</small>` : ''}</span></button>`).join('')}</div>`;
  }

  // ---- paper deposits ----
  async function depositPane(pane) {
    const coin = state.data.coins.find((c) => c.code === state.coin);
    pane.innerHTML = `
      <div class="field-label" style="margin-bottom:8px">Currency</div>
      ${coinGrid(state.coin, 'data-coin')}
      <div class="field-label" style="margin-bottom:8px">Your ${esc(coin.name)} deposit address <span class="aside">${esc(coin.network)}</span></div>
      <div class="addr-box"><div class="qr skel"></div><div class="row"><div class="addr skel" style="height:34px"></div></div></div>
      <div class="callout">Paper money: this address does not exist on any real network. Never send real ${esc(coin.code)} to it.</div>
      <div class="field">
        <div class="field-label">Send a test deposit <span class="aside">Arrives after ${coin.confirmations} confirmation${coin.confirmations > 1 ? 's' : ''}</span></div>
        <div class="chips" style="grid-template-columns:repeat(4,1fr)">
          ${[2500, 10000, 50000, 100000].map((v) => `<button class="chip" data-amt="${v}">${money(v).replace('.00', '')}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <div class="input-wrap"><span class="input-suffix">$</span><input class="input" id="dep-amt" inputmode="decimal" value="100.00"><span class="input-suffix" id="dep-coin">${esc(toCoin(10000, coin))} ${esc(coin.code)}</span></div>
      </div>
      <button class="btn btn-green btn-lg" id="dep-go">Send test deposit</button>
      <h4 style="margin:22px 0 4px;font-size:14px">Recent deposits</h4>
      <div id="wl-deps"></div>`;
    pane.querySelectorAll('[data-coin]').forEach((b) => (b.onclick = () => { state.coin = b.dataset.coin; depositPane(pane); }));
    const amt = pane.querySelector('#dep-amt');
    const coinOut = pane.querySelector('#dep-coin');
    const sync = () => { coinOut.textContent = `${toCoin(cents(amt.value), coin)} ${coin.code}`; };
    amt.oninput = sync;
    pane.querySelectorAll('[data-amt]').forEach((b) => (b.onclick = () => { amt.value = (b.dataset.amt / 100).toFixed(2); sync(); }));
    pane.querySelector('#dep-go').onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api('/api/wallet/deposit', { coin: coin.code, amount: cents(amt.value) });
        toast('Deposit detected', { kind: 'info', body: 'Waiting for confirmations.' });
        await load(false);
      } catch (err) { toast(err.message, { kind: 'bad' }); }
      btn.disabled = false;
    };
    paintLists();
    try {
      const a = await api('/api/wallet/address', { coin: coin.code });
      if (state.coin !== coin.code) return;
      pane.querySelector('.addr-box').innerHTML = `
        <div class="qr">${a.qr}</div>
        <div class="row">
          <div class="addr">${esc(a.address)}</div>
          <button class="btn btn-gray btn-sm" id="cp" style="align-self:flex-start">${icon('copy')}Copy address</button>
        </div>`;
      copyButton(pane.querySelector('#cp'), a.address, 'Copy address');
    } catch (err) { toast(err.message, { kind: 'bad' }); }
  }

  // ---- real deposits ----
  function liveDepositPane(pane) {
    const coin = state.data.coins.find((c) => c.code === state.coin);
    if (coin.ownAddress) return btcPane(pane, coin);
    const min = state.data.minDeposit;
    pane.innerHTML = `
      <div class="field-label" style="margin-bottom:8px">Currency</div>
      ${coinGrid(state.coin, 'data-coin')}
      <div class="field">
        <div class="field-label">Amount <span class="aside">${esc(coin.name)} on ${esc(coin.network)}</span></div>
        <div class="chips" style="grid-template-columns:repeat(4,1fr);margin-bottom:6px">
          ${[1000, 2500, 10000, 50000].map((v) => `<button class="chip" data-amt="${v}">${money(v).replace('.00', '')}</button>`).join('')}
        </div>
        <div class="input-wrap"><span class="input-suffix">$</span><input class="input" id="dep-amt" inputmode="decimal" value="25.00"><span class="input-suffix" id="dep-coin"></span></div>
      </div>
      <div class="form-error" id="dep-err"></div>
      <button class="btn btn-green btn-lg" id="dep-go">Get deposit address</button>
      <p class="fine" style="margin-top:10px">Minimum ${money(min)}. You'll get an address and the exact ${esc(coin.label)} amount to send, priced when you click.</p>
      <div id="wl-open"></div>
      <h4 style="margin:22px 0 4px;font-size:14px">Recent deposits</h4>
      <div id="wl-deps"></div>`;
    pane.querySelectorAll('[data-coin]').forEach((b) => (b.onclick = () => { state.coin = b.dataset.coin; liveDepositPane(pane); }));
    const amt = pane.querySelector('#dep-amt');
    const coinOut = pane.querySelector('#dep-coin');
    const sync = () => {
      const c = toCoin(cents(amt.value), coin);
      coinOut.textContent = c && !coin.stable ? `about ${c} ${coin.label}` : '';
    };
    amt.oninput = sync;
    sync();
    pane.querySelectorAll('[data-amt]').forEach((b) => (b.onclick = () => { amt.value = (b.dataset.amt / 100).toFixed(2); sync(); }));
    pane.querySelector('#dep-go').onclick = async (e) => {
      const btn = e.currentTarget;
      const err = pane.querySelector('#dep-err');
      err.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Getting address...';
      try {
        const r = await api('/api/wallet/deposit', { coin: coin.code, amount: cents(amt.value) });
        state.invoice = r.deposit;
        load(false);
        invoicePane(pane);
        return;
      } catch (ex) { err.textContent = ex.message; }
      btn.disabled = false;
      btn.textContent = 'Get deposit address';
    };
    paintLists();
  }

  // Bitcoin: one address per player, any amount, priced when it confirms.
  async function btcPane(pane, coin) {
    pane.innerHTML = `
      <div class="field-label" style="margin-bottom:8px">Currency</div>
      ${coinGrid(state.coin, 'data-coin')}
      <div class="field-label" style="margin-bottom:8px">Your bitcoin deposit address <span class="aside">${esc(coin.network)}</span></div>
      <div class="addr-box" data-watching><div class="qr skel"></div><div class="row"><div class="addr skel" style="height:34px"></div></div></div>
      <p class="fine" style="margin:10px 0 0">Send any amount${coin.rate ? ` (1 BTC is about ${money(Math.round(coin.rate * 100)).replace(/\.\d\d$/, '')})` : ''}. It is credited in dollars at the bitcoin price when it reaches ${coin.confirmations} confirmations, usually 10 to 30 minutes. This address stays yours, so you can use it again.</p>
      <div class="callout">Send only bitcoin, on the Bitcoin network. Other coins or networks sent here are lost.</div>
      <button class="btn btn-gray btn-block" id="chk">Check for payment</button>
      <h4 style="margin:22px 0 4px;font-size:14px">Recent deposits</h4>
      <div id="wl-deps"></div>`;
    pane.querySelectorAll('[data-coin]').forEach((b) => (b.onclick = () => { state.coin = b.dataset.coin; liveDepositPane(pane); }));
    pane.querySelector('#chk').onclick = () => checkNow(true);
    paintLists();
    try {
      const a = await api('/api/wallet/address', { coin: coin.code });
      if (state.coin !== coin.code || !pane.isConnected) return;
      pane.querySelector('.addr-box').innerHTML = `
        <div class="qr">${a.qr}</div>
        <div class="row">
          <div class="addr">${esc(a.address)}</div>
          <button class="btn btn-gray btn-sm" id="cp" style="align-self:flex-start">${icon('copy')}Copy address</button>
        </div>`;
      copyButton(pane.querySelector('#cp'), a.address, 'Copy address');
    } catch (err) { toast(err.message, { kind: 'bad' }); }
  }

  async function refreshInvoice() {
    try {
      const r = await api(`/api/wallet/deposits/${state.invoice.id}`);
      state.invoice = r.deposit;
      const pane = m.body.querySelector('#wl-pane');
      if (pane && state.tab === 'deposit') invoicePane(pane);
    } catch {}
  }

  async function showInvoice(id) {
    try {
      state.invoice = (await api(`/api/wallet/deposits/${id}`)).deposit;
      state.tab = 'deposit';
      paint();
    } catch (e) { toast(e.message, { kind: 'bad' }); }
  }

  function invoicePane(pane) {
    const d = state.invoice;
    const status = {
      awaiting: `<div class="status wait">Waiting for your payment. <span id="inv-left">${leftText(d.expires_at)}</span></div>`,
      expired: '<div class="status">This address has expired. Start a new deposit, or if you already sent the payment, contact support with the transaction id.</div>',
      confirming: `<div class="status wait">Payment seen. Waiting for confirmations (${d.confirmations || 0}/2).</div><div class="bar" style="margin-left:0;width:100%"><i style="width:${((d.confirmations || 0) / 2) * 100}%"></i></div>`,
      credited: `<div class="status ok">${icon('check')}Credited ${money(d.credited)}</div>`,
      held: '<div class="status bad">Received and on hold. Contact support.</div>',
    }[d.status] || '';
    pane.innerHTML = `
      <button class="btn btn-ghost btn-sm" id="inv-back" style="margin:-4px 0 10px">${icon('prev')}New deposit</button>
      <div class="field-label" style="margin-bottom:6px">Send exactly <span class="aside">${esc(d.network || '')}</span></div>
      <div class="pay-amt">
        ${coinIcon(d.label)}<b class="num" id="inv-amt">${esc(d.coin_amount)}</b><span>${esc(d.label)}</span>
        <button class="btn btn-gray btn-sm" id="cp-amt">${icon('copy')}Copy</button>
      </div>
      <p class="fine" style="margin:6px 0 12px">Credits ${money(d.amount)}${d.coin_amount !== (d.amount / 100).toFixed(2) ? '. The extra cent tells your payment apart from someone else\'s.' : '.'}</p>
      <div class="field-label" style="margin-bottom:6px">To this address</div>
      <div class="addr-box">
        <div class="qr">${d.qr || ''}</div>
        <div class="row">
          <div class="addr">${esc(d.address)}</div>
          <button class="btn btn-gray btn-sm" id="cp-addr" style="align-self:flex-start">${icon('copy')}Copy address</button>
        </div>
      </div>
      <div style="margin:14px 0 4px" ${d.status === 'awaiting' || d.status === 'expired' ? 'data-watching' : ''}>${status}</div>
      <div class="callout">Send exactly ${esc(d.coin_amount)} ${esc(d.label)} on ${esc(d.network)}, nothing else. The exact amount is how your payment is matched to your account. If your exchange takes its fee out of the amount it sends, the deposit won't match automatically: send the amount plus the fee, or contact support with the transaction id.</div>
      ${d.status === 'awaiting' || d.status === 'expired' ? '<button class="btn btn-gray btn-block" id="chk">Check for payment</button>' : ''}
    `;
    pane.querySelector('#inv-back').onclick = () => { state.invoice = null; liveDepositPane(pane); };
    pane.querySelector('#chk')?.addEventListener('click', () => checkNow(true));
    copyButton(pane.querySelector('#cp-amt'), d.coin_amount, 'Copy');
    copyButton(pane.querySelector('#cp-addr'), d.address, 'Copy address');
  }

  // ---- withdrawals ----
  function withdrawPane(pane) {
    const coin = state.data.coins.find((c) => c.code === state.wcoin);
    const fee = state.data.feeBps / 100;
    const bal = store.user.balance;
    pane.innerHTML = `
      <div class="field-label" style="margin-bottom:8px">Currency</div>
      ${coinGrid(state.wcoin, 'data-wcoin')}
      <div class="field">
        <label class="field-label" for="wd-addr">Your ${esc(coin.name)} address <span class="aside">${esc(coin.network)}</span></label>
        <input class="input" id="wd-addr" spellcheck="false" autocomplete="off" placeholder="${esc(placeholder(coin))}">
      </div>
      <div class="field">
        <label class="field-label" for="wd-amt">Amount <span class="aside num" id="wd-avail">Available ${money(bal)}</span></label>
        <div class="input-wrap"><span class="input-suffix">$</span><input class="input" id="wd-amt" inputmode="decimal" placeholder="0.00"><div class="input-sep"></div><button class="input-btn" id="wd-max">Max</button></div>
      </div>
      <div class="sum" id="wd-sum"></div>
      <div class="form-error" id="wd-err"></div>
      <button class="btn btn-green btn-lg" id="wd-go">Withdraw</button>
      <p class="fine" style="margin-top:10px">Every withdrawal carries a ${fee}% fee. Minimum ${money(state.data.minWithdraw)}. Funds in an active game or queue can't be withdrawn until it ends.${live ? ` Withdrawals are checked and sent by staff, and the transaction id shows here once it's sent. Double-check the address and network: coins sent to a wrong address can't be recovered.` : ''}</p>
      <h4 style="margin:22px 0 4px;font-size:14px">Recent withdrawals</h4>
      <div id="wl-wds"></div>`;
    pane.querySelectorAll('[data-wcoin]').forEach((b) => (b.onclick = () => { state.wcoin = b.dataset.wcoin; withdrawPane(pane); }));
    const amt = pane.querySelector('#wd-amt');
    const sum = pane.querySelector('#wd-sum');
    const sync = () => {
      const a = cents(amt.value);
      const f = Math.round((a * state.data.feeBps) / 10000);
      const c = toCoin(a - f, coin);
      sum.innerHTML = `
        <div><span>Amount</span><b>${money(a)}</b></div>
        <div><span>Fee (${fee}%)</span><b>-${money(f)}</b></div>
        <div class="total"><span>You receive</span><b>${money(a - f)}${c ? ` <span class="dim">· ${live && !coin.stable ? 'about ' : ''}${c} ${esc(coin.label)}</span>` : ''}</b></div>`;
    };
    amt.oninput = sync;
    pane.querySelector('#wd-max').onclick = () => { amt.value = (store.user.balance / 100).toFixed(2); sync(); };
    sync();
    pane.querySelector('#wd-go').onclick = async (e) => {
      const err = pane.querySelector('#wd-err');
      err.textContent = '';
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const r = await api('/api/wallet/withdraw', { coin: coin.code, address: pane.querySelector('#wd-addr').value, amount: cents(amt.value) });
        store.set({ user: { ...store.user, ...r.user } });
        if (r.withdrawal.status === 'review') toast('Withdrawal submitted', { kind: 'info', body: 'It is waiting on a routine security review.', ms: 7000 });
        else toast('Withdrawal submitted', { kind: 'info', body: `${money(r.withdrawal.net)} after the fee.` });
        amt.value = '';
        await load(false);
        withdrawPane(pane);
      } catch (ex) { err.textContent = ex.message; }
      btn.disabled = false;
    };
    paintLists();
  }

  function depositStatus(x) {
    if (x.status === 'pending' || x.status === 'confirming') {
      const req = x.required || 2;
      return `<span class="status wait">${x.confirmations || 0}/${req} confirmations</span><div class="bar"><i style="width:${((x.confirmations || 0) / req) * 100}%"></i></div>`;
    }
    const [cls, text] = {
      credited: ['ok', 'Credited'], forfeited: ['bad', 'Forfeited'], awaiting: ['wait', 'Waiting for payment'],
      expired: ['', 'Expired'], held: ['bad', 'On hold'], dropped: ['bad', 'Not confirmed'],
    }[x.status] || ['', x.status];
    return `<span class="status ${cls}">${text}</span>`;
  }

  function paintLists() {
    const d = state.data;
    if (!d) return;
    const open = m.body.querySelector('#wl-open');
    const waiting = d.deposits.filter((x) => x.kind === 'invoice' && (x.status === 'awaiting' || x.status === 'confirming'));
    if (open) open.innerHTML = waiting.length ? `
      <h4 style="margin:22px 0 4px;font-size:14px">Waiting for payment</h4>
      ${waiting.map((x) => `
        <button class="tx tx-btn" data-inv="${x.id}">
          ${coinIcon(x.label)}
          <div class="k"><div>${esc(x.coin_amount)} ${esc(x.label)}</div><span>${ago(x.created_at)} · tap to show the address</span></div>
          <div class="amt num">${money(x.amount)}${depositStatus(x)}</div>
        </button>`).join('')}` : '';
    const deps = m.body.querySelector('#wl-deps');
    const shown = d.deposits.filter((x) => !waiting.includes(x)).slice(0, 6);
    if (deps) deps.innerHTML = shown.length ? shown.map((x) => `
      <${x.kind === 'invoice' ? `button class="tx tx-btn" data-inv="${x.id}"` : 'div class="tx"'}>
        ${coinIcon(x.label || x.coin || '?')}
        <div class="k"><div>${x.coin_amount ? `${esc(x.coin_amount)} ${esc(x.label || x.coin)}` : esc(x.kind === 'manual' ? 'Credited by staff' : x.label || '')}</div><span>${ago(x.created_at)}</span></div>
        <div class="amt num">${x.kind === 'chain' && x.status === 'confirming' ? (x.amount ? `about ${money(x.amount)}` : '') : money(x.status === 'credited' && x.credited != null ? x.credited : x.amount)}${depositStatus(x)}</div>
      </${x.kind === 'invoice' ? 'button' : 'div'}>`).join('') : '<div class="empty" style="padding:18px">No deposits yet</div>';
    m.body.querySelectorAll('[data-inv]').forEach((b) => (b.onclick = () => showInvoice(+b.dataset.inv)));
    const wds = m.body.querySelector('#wl-wds');
    if (wds) wds.innerHTML = d.withdrawals.length ? d.withdrawals.slice(0, 6).map((x) => `
      <div class="tx">
        ${coinIcon(x.label || x.coin)}
        <div class="k"><div>${x.coin_amount ? `${esc(x.coin_amount)} ${esc(x.label || x.coin)}` : esc(x.label || x.coin)}</div><span title="${esc(x.address)}">to ${esc(x.address.slice(0, 8))}...${esc(x.address.slice(-6))} · ${ago(x.created_at)}</span>${x.txid && live ? `<span class="txid" title="${esc(x.txid)}">tx ${esc(x.txid.slice(0, 10))}...${esc(x.txid.slice(-6))}</span>` : ''}${x.status === 'rejected' && x.note ? `<span>${esc(x.note)}</span>` : ''}</div>
        <div class="amt num">${money(x.amount)}<span class="status ${{ completed: 'ok', processing: 'wait', review: 'wait', rejected: 'bad' }[x.status]}">${{ completed: 'Sent', processing: live ? 'Pending' : 'Processing', review: 'Under review', rejected: 'Declined' }[x.status]}</span></div>
      </div>`).join('') : '<div class="empty" style="padding:18px">No withdrawals yet</div>';
    const tx = m.body.querySelector('#wl-tx');
    if (tx) tx.innerHTML = d.ledger.length ? d.ledger.map((x) => `
      <div class="tx">
        <div class="k"><div>${esc(KIND[x.kind] || x.kind)}</div><span>${dateTime(x.created_at)}${x.note ? ` · ${esc(x.note)}` : ''}</span></div>
        <div class="amt num ${x.amount > 0 ? 'green' : ''}">${money(x.amount, { sign: true })}<span>Balance ${money(x.balance_after)}</span></div>
      </div>`).join('') : '<div class="empty">No transactions yet</div>';
  }

  load();
}

function copyButton(btn, text, labelText) {
  btn.onclick = async () => {
    try { await navigator.clipboard.writeText(text); } catch {}
    btn.innerHTML = `${icon('check')}Copied`;
    setTimeout(() => { btn.innerHTML = `${icon('copy')}${labelText}`; }, 1600);
  };
}

function leftText(expiresAt) {
  const min = Math.round((expiresAt - Date.now()) / 60000);
  if (min <= 0) return 'Send it now.';
  return `Send it within ${min} minute${min === 1 ? '' : 's'}.`;
}

function netTag(network) {
  const m = /\(([^)]+)\)/.exec(network);
  return m ? m[1] : network;
}

function cents(v) {
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
function toCoin(c, coin) { return coin.rate ? (c / 100 / coin.rate).toFixed(coin.decimals) : null; }
function placeholder(coin) {
  const n = coin.network || '';
  if (/^Bitcoin/.test(n)) return 'bc1q...';
  if (/^Tron/.test(n)) return 'T...';
  if (/^Solana/.test(n)) return 'Solana address';
  if (/^(Ethereum|BNB)/.test(n)) return '0x...';
  return { LTC: 'ltc1q...', DOGE: 'D...' }[coin.code] || '';
}

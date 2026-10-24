import { api, openModal, money, esc, icon, coinIcon, toast, dateTime, ago } from '../lib.js';
import { store, bus } from '../store.js';

const KIND = {
  deposit: 'Deposit', withdrawal: 'Withdrawal', stake: 'Wager placed', stake_return: 'Wager returned', win: 'Win', draw: 'Draw',
  forfeit: 'Forfeited', fairplay_refund: 'Fair-play refund', reinstated: 'Balance restored',
};

let state = { tab: 'deposit', coin: 'BTC', wcoin: 'BTC', data: null };

export function openWallet(tab) {
  if (tab) state.tab = tab;
  const m = openModal({
    title: 'Wallet', iconName: 'wallet', width: 520, body: '<div class="skel" style="height:260px"></div>',
    foot: 'Paper money. Deposits and withdrawals are simulated and nothing leaves this site.',
    onClose: () => { offs.forEach((f) => f()); },
  });
  const offs = [
    bus.on('wallet', () => load(false)),
    bus.on('store', (p) => {
      if (!('user' in p) || !store.user) return;
      const shown = m.body.dataset.status;
      if (shown && shown !== store.user.status) return paint();
      const av = m.body.querySelector('#wd-avail');
      if (av) av.textContent = `Available ${money(store.user.balance)}`;
    }),
  ];

  async function load(full = true) {
    try {
      state.data = await api('/api/wallet');
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
    m.body.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; paint(); }));
    const pane = m.body.querySelector('#wl-pane');
    if (state.tab === 'deposit') depositPane(pane);
    if (state.tab === 'withdraw') withdrawPane(pane);
    if (state.tab === 'tx') { pane.innerHTML = '<div id="wl-tx"></div>'; paintLists(); }
  }

  function coinGrid(selected, attr) {
    return `<div class="coin-grid">${state.data.coins.map((c) => `
      <button class="coin-opt ${c.code === selected ? 'on' : ''}" ${attr}="${c.code}" title="${esc(c.name)}">${coinIcon(c.code)}${esc(c.code)}</button>`).join('')}</div>`;
  }

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
      pane.querySelector('#cp').onclick = async (ev) => {
        try { await navigator.clipboard.writeText(a.address); } catch {}
        ev.currentTarget.innerHTML = `${icon('check')}Copied`;
      };
    } catch (err) { toast(err.message, { kind: 'bad' }); }
  }

  function withdrawPane(pane) {
    const coin = state.data.coins.find((c) => c.code === state.wcoin);
    const fee = state.data.feeBps / 100;
    const bal = store.user.balance;
    pane.innerHTML = `
      <div class="field-label" style="margin-bottom:8px">Currency</div>
      ${coinGrid(state.wcoin, 'data-wcoin')}
      <div class="field">
        <label class="field-label" for="wd-addr">${esc(coin.name)} address <span class="aside">${esc(coin.network)}</span></label>
        <input class="input" id="wd-addr" spellcheck="false" autocomplete="off" placeholder="${esc(placeholder(coin.code))}">
      </div>
      <div class="field">
        <label class="field-label" for="wd-amt">Amount <span class="aside num" id="wd-avail">Available ${money(bal)}</span></label>
        <div class="input-wrap"><span class="input-suffix">$</span><input class="input" id="wd-amt" inputmode="decimal" placeholder="0.00"><div class="input-sep"></div><button class="input-btn" id="wd-max">Max</button></div>
      </div>
      <div class="sum" id="wd-sum"></div>
      <div class="form-error" id="wd-err"></div>
      <button class="btn btn-green btn-lg" id="wd-go">Withdraw</button>
      <p class="fine" style="margin-top:10px">Every withdrawal carries a ${fee}% fee. Minimum ${money(state.data.minWithdraw)}. Funds in an active game or queue can't be withdrawn until it ends.</p>
      <h4 style="margin:22px 0 4px;font-size:14px">Recent withdrawals</h4>
      <div id="wl-wds"></div>`;
    pane.querySelectorAll('[data-wcoin]').forEach((b) => (b.onclick = () => { state.wcoin = b.dataset.wcoin; withdrawPane(pane); }));
    const amt = pane.querySelector('#wd-amt');
    const sum = pane.querySelector('#wd-sum');
    const sync = () => {
      const a = cents(amt.value);
      const f = Math.round((a * state.data.feeBps) / 10000);
      sum.innerHTML = `
        <div><span>Amount</span><b>${money(a)}</b></div>
        <div><span>Fee (${fee}%)</span><b>-${money(f)}</b></div>
        <div class="total"><span>You receive</span><b>${money(a - f)} <span class="dim">· ${toCoin(a - f, coin)} ${esc(coin.code)}</span></b></div>`;
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

  function paintLists() {
    const d = state.data;
    const deps = m.body.querySelector('#wl-deps');
    if (deps) deps.innerHTML = d.deposits.length ? d.deposits.slice(0, 6).map((x) => `
      <div class="tx">
        ${coinIcon(x.coin)}
        <div class="k"><div>${esc(x.coin_amount)} ${esc(x.coin)}</div><span>${ago(x.created_at)}</span></div>
        <div class="amt num">${money(x.amount)}
          ${x.status === 'pending'
            ? `<span class="status wait">${x.confirmations}/${x.required} confirmations</span><div class="bar"><i style="width:${(x.confirmations / x.required) * 100}%"></i></div>`
            : `<span class="status ${x.status === 'credited' ? 'ok' : 'bad'}">${x.status === 'credited' ? 'Credited' : 'Forfeited'}</span>`}
        </div>
      </div>`).join('') : '<div class="empty" style="padding:18px">No deposits yet</div>';
    const wds = m.body.querySelector('#wl-wds');
    if (wds) wds.innerHTML = d.withdrawals.length ? d.withdrawals.slice(0, 6).map((x) => `
      <div class="tx">
        ${coinIcon(x.coin)}
        <div class="k"><div>${esc(x.coin_amount)} ${esc(x.coin)}</div><span title="${esc(x.address)}">to ${esc(x.address.slice(0, 8))}...${esc(x.address.slice(-6))} · ${ago(x.created_at)}</span></div>
        <div class="amt num">${money(x.amount)}<span class="status ${{ completed: 'ok', processing: 'wait', review: 'wait', rejected: 'bad' }[x.status]}">${{ completed: 'Sent', processing: 'Processing', review: 'Under review', rejected: 'Rejected' }[x.status]}</span></div>
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

function cents(v) {
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
function toCoin(c, coin) { return (c / 100 / coin.rate).toFixed(coin.decimals); }
function placeholder(code) {
  return { BTC: 'bc1q...', ETH: '0x...', USDT: '0x...', USDC: '0x...', SOL: 'Solana address', LTC: 'ltc1q...', DOGE: 'D...' }[code];
}

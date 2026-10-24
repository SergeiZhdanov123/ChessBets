import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { config } from './config.js';
import { MoneyError, withdrawFeeOf } from './money.js';
import { BCON_COINS, createBcon, ownAddress, sameAddress, units } from './bcon.js';

// Two modes. With PAYMENTS=paper (the default) nothing touches a real chain:
// deposit addresses are deliberately not valid on any network so nobody can
// lose real funds by sending to one, and rates are fixed reference prices.
// With PAYMENTS=bcon, deposits are real payments through Bcon Global and
// withdrawals are sent by staff from Admin.
export const COINS = {
  BTC: { name: 'Bitcoin', network: 'Bitcoin', rate: 100_000, decimals: 8, confirmations: 2, re: /^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/ },
  ETH: { name: 'Ethereum', network: 'Ethereum', rate: 3_500, decimals: 6, confirmations: 3, re: /^0x[a-fA-F0-9]{40}$/ },
  USDT: { name: 'Tether', network: 'Ethereum (ERC-20)', rate: 1, decimals: 2, confirmations: 3, re: /^0x[a-fA-F0-9]{40}$/ },
  USDC: { name: 'USD Coin', network: 'Ethereum (ERC-20)', rate: 1, decimals: 2, confirmations: 3, re: /^0x[a-fA-F0-9]{40}$/ },
  SOL: { name: 'Solana', network: 'Solana', rate: 180, decimals: 4, confirmations: 1, re: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ },
  LTC: { name: 'Litecoin', network: 'Litecoin', rate: 90, decimals: 6, confirmations: 2, re: /^(ltc1[a-z0-9]{25,62}|[LM3][a-km-zA-HJ-NP-Z1-9]{26,33})$/ },
  DOGE: { name: 'Dogecoin', network: 'Dogecoin', rate: 0.2, decimals: 2, confirmations: 2, re: /^D[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{32}$/ },
};

export const coinList = () => Object.entries(COINS).map(([code, c]) => ({ code, label: code, name: c.name, network: c.network, rate: c.rate, decimals: c.decimals, confirmations: c.confirmations }));

export const toCoin = (cents, coin) => {
  const c = COINS[coin];
  return (cents / 100 / c.rate).toFixed(c.decimals);
};

const B32 = 'abcdefghjkmnpqrstuvwxyz23456789';
function demoAddress(coin) {
  const bytes = crypto.randomBytes(28);
  let s = '';
  for (const b of bytes) s += B32[b % B32.length];
  return `demo-${coin.toLowerCase()}-${s}`;
}

const DAY = 86_400_000;
// A payment in one of these states has been dealt with and is never
// credited again.
const SETTLED = ['credited', 'held', 'manual'];

export function createWallet(ctx) {
  const { db, money, hub } = ctx;
  const now = () => Date.now();
  const txid = () => 'demo' + crypto.randomBytes(30).toString('hex');
  const live = config.payments === 'bcon';
  const bcon = live
    ? ctx.bcon || createBcon({ key: config.bconKey, base: config.bconApi, storeId: config.bconStoreId, chains: config.bconChains })
    : null;

  function coins() {
    if (!live) return coinList();
    const chains = new Set(bcon.enabledChains());
    return Object.entries(BCON_COINS)
      .filter(([code, c]) => chains.has(c.chain) && (!config.bconCoins.length || config.bconCoins.includes(code)))
      .map(([code, c]) => ({
        code, label: c.label, name: c.name, network: c.network, decimals: c.decimals, confirmations: 2,
        rate: c.stable ? 1 : bcon.cachedRate(c.ticker), stable: !!c.stable, ownAddress: ownAddress(code),
      }));
  }
  const coinDef = (code) => (live ? BCON_COINS[code] : COINS[code]);
  const label = (code) => (live ? BCON_COINS[code]?.label : code) || code;

  function checkCoin(code) {
    if (coins().some((c) => c.code === code)) return;
    if (live && !coins().length) throw new MoneyError('unavailable', 'Crypto payments are unavailable right now. Try again shortly.');
    throw new MoneyError('bad_coin', 'Unsupported currency');
  }
  function coinAmount(cents, code) {
    const c = coins().find((x) => x.code === code);
    return c?.rate ? (cents / 100 / c.rate).toFixed(c.decimals) : null;
  }

  // ---------------------------------------------------------------- paper

  async function address(userId, coin) {
    if (live) throw new MoneyError('bad_request', 'Choose an amount to get a deposit address');
    checkCoin(coin);
    let row = await db.deposit_addresses.findOne({ user_id: userId, coin });
    if (!row) {
      const addr = demoAddress(coin);
      try {
        await db.deposit_addresses.insert({ user_id: userId, coin, address: addr, created_at: now() });
        row = { address: addr };
      } catch (e) {
        if (e.code !== 11000) throw e;
        row = await db.deposit_addresses.findOne({ user_id: userId, coin }); // two tabs asked at once
      }
    }
    return { coin, address: row.address, qr: await qr(row.address) };
  }

  const qr = (text) => QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#0f212eff', light: '#ffffffff' } });

  // Simulates an incoming transfer: it shows up unconfirmed, ticks through
  // confirmations, then credits the balance.
  async function testDeposit(user, coin, amount) {
    checkCoin(coin);
    if (user.status !== 'active') throw new MoneyError('suspended', 'Account suspended');
    if (!Number.isInteger(amount) || amount < 100) throw new MoneyError('bad_amount', 'Minimum deposit is $1.00');
    if (amount > config.maxTestDeposit) throw new MoneyError('bad_amount', 'Maximum test deposit is $1,000.00');
    const today = await db.deposits.sum('$amount', { user_id: user.id, created_at: { $gt: now() - DAY } });
    if (today + amount > config.dailyTestDepositCap) throw new MoneyError('cap', 'Daily test deposit limit is $10,000.00');
    const addr = await db.deposit_addresses.findOne({ user_id: user.id, coin });
    if (!addr) throw new MoneyError('no_address', 'Generate a deposit address first');
    const c = COINS[coin];
    const id = await db.nextId('deposits');
    await db.deposits.insert({
      _id: id, user_id: user.id, coin, address: addr.address, amount, coin_amount: toCoin(amount, coin),
      confirmations: 0, required: c.confirmations, status: 'pending', txid: txid(), created_at: now(), credited_at: null,
    });
    scheduleConfirm(id);
    return depositRow(id);
  }

  function scheduleConfirm(id) {
    setTimeout(() => ctx.track(confirmStep(id).catch((e) => console.error('deposit', id, e.message))), config.depositConfirmMs).unref?.();
  }

  async function confirmStep(id) {
    if (ctx.closed) return;
    const d = await db.deposits.findOne({ _id: id });
    if (!d || d.status !== 'pending') return;
    const conf = d.confirmations + 1;
    if (conf < d.required) {
      await db.deposits.update({ _id: id, status: 'pending' }, { $set: { confirmations: conf } });
      hub.toUser(d.user_id, { t: 'wallet', deposit: await depositRow(id) });
      scheduleConfirm(id);
      return;
    }
    await db.tx(async () => {
      const u = await db.users.findOne({ _id: d.user_id }, { projection: { status: 1 } });
      const status = u.status === 'active' ? 'credited' : 'forfeited';
      const r = await db.deposits.update({ _id: id, status: 'pending' }, { $set: { confirmations: conf, status, credited_at: now() } });
      if (!r.modifiedCount) return;
      // Funds sent to a suspended account are forfeited like the rest.
      if (status === 'forfeited') await money.house(d.amount, 'forfeit', `deposit:${id}`);
      else await money.userEntry(d.user_id, d.amount, 'deposit', `deposit:${id}`, `${d.coin_amount} ${d.coin}`);
    });
    hub.toUser(d.user_id, { t: 'wallet', deposit: await depositRow(id) });
    hub.pushBalance(d.user_id);
  }

  // ----------------------------------------------------------------- bcon

  // Opens a deposit for a dollar amount. Bitcoin gets its own address; on
  // the other chains the exact coin amount is what identifies the deposit.
  async function openDeposit(user, coin, amount) {
    checkCoin(coin);
    if (user.status !== 'active') throw new MoneyError('suspended', 'Account suspended');
    if (!Number.isInteger(amount) || amount < config.bconMinDeposit) throw new MoneyError('bad_amount', `Minimum deposit is $${(config.bconMinDeposit / 100).toFixed(2)}`);
    if (amount > config.bconMaxDeposit) throw new MoneyError('bad_amount', `Maximum deposit is $${(config.bconMaxDeposit / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    const open = await db.deposits.find(
      { user_id: user.id, kind: 'bcon', status: 'awaiting', expires_at: { $gt: now() } },
      { projection: { coin: 1, amount: 1 } },
    );
    const same = open.find((d) => d.coin === coin && d.amount === amount);
    if (same) return invoice(user.id, same.id);
    if (open.length >= config.bconOpenInvoices) throw new MoneyError('too_many', 'You have 3 deposits waiting for payment. Pay one or wait for it to expire.');

    const id = await db.nextId('deposits');
    let addr;
    try {
      addr = await bcon.newAddress(coin, amount, `cb-${id}`);
    } catch (e) {
      console.error('bcon address', e.message);
      throw new MoneyError('unavailable', 'Could not get a deposit address right now. Try again in a minute.');
    }
    const t = now();
    await db.deposits.insert({
      _id: id, kind: 'bcon', user_id: user.id, coin, address: addr.address, amount, coin_amount: addr.amount,
      credited: 0, status: 'awaiting', txid: null, txids: [], confirmations: 0, required: 2,
      created_at: t, expires_at: t + config.bconInvoiceMs, seen_at: null, credited_at: null,
    });
    return invoice(user.id, id);
  }

  async function invoice(userId, id) {
    const d = await db.deposits.findOne({ _id: id, user_id: userId }, { projection: DEPOSIT_FIELDS });
    if (!d) throw Object.assign(new MoneyError('not_found', 'Deposit not found'), { status: 404 });
    const uri = d.address && d.coin === 'BTC' ? `bitcoin:${d.address}?amount=${d.coin_amount}` : d.address;
    return { ...d, label: label(d.coin), network: coinDef(d.coin)?.network, qr: d.address ? await qr(uri) : null };
  }

  // Bcon's callback. Only the txid is trusted, and only after Bcon's API
  // confirms it with our key.
  async function notify(p) {
    const id = String(p.txid || '').trim();
    if (!/^[A-Za-z0-9]{8,128}$/.test(id)) return 'ignored';
    const ext = /^cb-(\d+)$/.exec(String(p.external_id || ''));
    try {
      return await settle(id, { invoiceId: ext ? Number(ext[1]) : null });
    } catch (e) {
      // Bcon could not be asked right now. Remember the txid so the sweep
      // retries it, and let Bcon retry too.
      await db.payments.update(
        { _id: id, status: { $nin: SETTLED } },
        { $set: { updated_at: now(), note: e.message.slice(0, 200) }, $setOnInsert: { status: 'pending', first_seen: now(), invoice_id: ext ? Number(ext[1]) : null } },
        { upsert: true },
      ).catch((err) => { if (err.code !== 11000) throw err; });
      throw e;
    }
  }

  // One settle per txid at a time; a callback and the sweep can race.
  const settling = new Map();
  function settle(id, hint = {}) {
    let p = settling.get(id);
    if (!p) {
      p = settleNow(id, hint).finally(() => settling.delete(id));
      settling.set(id, p);
    }
    return p;
  }

  async function settleNow(id, hint) {
    const known = await db.payments.findOne({ _id: id });
    if (known && SETTLED.includes(known.status)) return known.status;
    const hinted = hint.invoiceId ?? known?.invoice_id ?? null;
    let inv = hinted ? await db.deposits.findOne({ _id: hinted, kind: 'bcon' }) : null;
    const tx = await bcon.transaction(id, inv ? BCON_COINS[inv.coin]?.chain : undefined);
    if (!tx.coin) return record(id, tx, null, 'unmatched', `Unknown currency ${tx.currencyId}`);
    if (!inv || inv.coin !== tx.coin || !sameAddress(tx.coin, inv.address, tx.address)) inv = await findInvoice(tx);
    if (!inv) return record(id, tx, null, 'unmatched', 'No open deposit matches this payment');

    if (tx.status !== 'confirmed') {
      await record(id, tx, inv, 'pending');
      const r = await db.deposits.update(
        { _id: inv.id, status: { $in: ['awaiting', 'expired'] } },
        { $set: { status: 'confirming', txid: tx.txid, seen_at: now(), confirmations: tx.status === 'partially_confirmed' ? 1 : 0 } },
      );
      if (r.modifiedCount) hub.toUser(inv.user_id, { t: 'wallet', deposit: await depositRow(inv.id) });
      return 'pending';
    }
    return credit(inv, tx, known);
  }

  async function findInvoice(tx) {
    if (ownAddress(tx.coin)) {
      return db.deposits.findOne({ kind: 'bcon', coin: tx.coin, address: tx.address }, { sort: { _id: -1 } });
    }
    const want = units(tx.sum);
    const open = await db.deposits.find(
      { kind: 'bcon', coin: tx.coin, status: { $in: ['awaiting', 'expired'] }, created_at: { $gt: now() - 3 * DAY } },
      { sort: { _id: 1 } },
    );
    return open.find((d) => sameAddress(tx.coin, d.address, tx.address) && units(d.coin_amount) === want) || null;
  }

  // Dollar value of a confirmed payment. Paid on time and within 0.5% of
  // the quote: exactly what was asked. Otherwise pro rata at the quoted
  // rate, and for a late payment in a volatile coin, at the current rate if
  // that is lower, so a stale quote can't be cashed in after a price drop.
  async function valueOf(inv, tx, known) {
    const paid = units(tx.sum);
    const asked = units(inv.coin_amount);
    if (!paid || !asked) return 0;
    const late = (known?.first_seen ?? now()) > inv.expires_at;
    const diff = paid > asked ? paid - asked : asked - paid;
    if (!late && diff * 200n <= asked) return inv.amount;
    let cents = Number((BigInt(inv.amount) * paid) / asked);
    const c = BCON_COINS[inv.coin];
    if (late && !c.stable) {
      const usd = await bcon.rate(c.ticker, { fresh: true }).catch(() => null);
      if (usd) cents = Math.min(cents, Math.floor(Number(tx.sum) * usd * 100));
    }
    return Math.max(0, cents);
  }

  async function credit(inv, tx, known) {
    const cents = await valueOf(inv, tx, known);
    if (cents < 1) return record(tx.txid, tx, inv, 'unmatched', 'Payment is worth less than a cent');
    const status = await db.tx(async () => {
      const done = await db.payments.findOne({ _id: tx.txid }, { projection: { status: 1 } });
      if (done && SETTLED.includes(done.status)) return null;
      const u = await db.users.findOne({ _id: inv.user_id }, { projection: { status: 1 } });
      // Money that reaches a suspended account is parked for staff, not
      // forfeited: it never entered the balance.
      const s = u?.status === 'active' ? 'credited' : 'held';
      await record(tx.txid, tx, inv, s, null, cents);
      if (s === 'credited') {
        await money.userEntry(inv.user_id, cents, 'deposit', `deposit:${inv.id}`, `${tx.sum} ${label(inv.coin)}, tx ${tx.txid.slice(0, 12)}`);
      }
      await db.deposits.update({ _id: inv.id }, {
        $set: { status: s === 'credited' || inv.status === 'credited' ? 'credited' : 'held', txid: inv.txid || tx.txid, confirmations: 2, credited_at: now() },
        $inc: { credited: s === 'credited' ? cents : 0 },
        $addToSet: { txids: tx.txid },
      });
      return s;
    });
    if (!status) return 'credited';
    hub.toUser(inv.user_id, { t: 'wallet', deposit: await depositRow(inv.id) });
    if (status === 'credited') hub.pushBalance(inv.user_id);
    return status;
  }

  function record(id, tx, inv, status, note = null, cents = null) {
    const t = now();
    return db.payments.update({ _id: id }, {
      $set: {
        status, note, coin: tx?.coin ?? null, address: tx?.address ?? null, sum: tx?.sum ?? null, chain_status: tx?.status ?? null,
        invoice_id: inv?.id ?? null, user_id: inv?.user_id ?? null, cents, updated_at: t,
      },
      $setOnInsert: { first_seen: t },
    }, { upsert: true }).then(() => status);
  }

  // Covers callbacks that never arrived (the server was asleep, Bcon gave
  // up) and payments that were still confirming.
  let sweeping = null;
  function sweep() {
    sweeping ??= (async () => {
      if (ctx.closed) return;
      if (bcon.storeAge > 10 * 60_000) await bcon.refreshStore().catch((e) => console.error('bcon store', e.message));
      for (const c of coins()) {
        if (!BCON_COINS[c.code].stable) await bcon.rate(BCON_COINS[c.code].ticker).catch(() => {});
      }

      for (const p of await db.payments.find({ status: 'pending', first_seen: { $gt: now() - 7 * DAY } }, { sort: { first_seen: 1 }, limit: 50 })) {
        if (ctx.closed) return;
        await settle(p.id).catch((e) => console.error('bcon settle', p.id, e.message));
      }

      await db.deposits.updateMany({ kind: 'bcon', status: 'awaiting', expires_at: { $lt: now() } }, { $set: { status: 'expired' } });
      const open = await db.deposits.find(
        { kind: 'bcon', status: { $in: ['awaiting', 'confirming', 'expired'] }, created_at: { $gt: now() - 2 * DAY } },
        { projection: { coin: 1, address: 1, created_at: 1 }, sort: { _id: -1 }, limit: 200 },
      );
      // One history call per address; the shared wallets are asked once.
      const byAddress = new Map();
      for (const d of open) {
        const k = `${BCON_COINS[d.coin].chain}|${d.address}`;
        const cur = byAddress.get(k);
        byAddress.set(k, { chain: BCON_COINS[d.coin].chain, address: d.address, since: Math.min(cur?.since ?? Infinity, d.created_at) });
      }
      for (const a of byAddress.values()) {
        if (ctx.closed) return;
        let txs;
        try { txs = await bcon.history(a.address, a.chain); } catch (e) { console.error('bcon history', e.message); continue; }
        for (const t of txs) {
          if (!t.coin || (t.at && t.at < a.since - 10 * 60_000)) continue;
          const known = await db.payments.findOne({ _id: t.txid }, { projection: { status: 1 } });
          if (known && known.status !== 'pending') continue;
          await settle(t.txid).catch((e) => console.error('bcon settle', t.txid, e.message));
        }
      }
    })().finally(() => { sweeping = null; });
    return sweeping;
  }

  let sweepTimer = null;
  async function startLive() {
    try {
      const s = await bcon.refreshStore();
      const chains = Object.keys(s.chains);
      console.log(`  bcon store ${s.name ?? '(forced chains)'}: ${chains.length ? chains.join(', ') : 'no wallets added yet'}`);
    } catch (e) {
      console.error(`  bcon: ${e.message}. Deposits stay off until this is fixed; retrying every few minutes.`);
    }
    sweepTimer = setInterval(() => ctx.track(sweep().catch((e) => console.error('bcon sweep', e.message))), config.bconPollMs);
    sweepTimer.unref?.();
    ctx.track(sweep().catch((e) => console.error('bcon sweep', e.message)));
  }

  async function resumePending() {
    if (live) {
      // Withdrawals wait for staff in live mode; only deposits need a sweep.
      await startLive();
      return;
    }
    for (const d of await db.deposits.find({ status: 'pending' }, { projection: { _id: 1 } })) scheduleConfirm(d.id);
    for (const w of await db.withdrawals.find({ status: 'processing' }, { projection: { _id: 1 } })) scheduleWithdraw(w.id);
  }

  // ----------------------------------------------------------- withdrawals

  async function withdraw(user, coin, address, amount) {
    checkCoin(coin);
    if (user.status !== 'active') throw new MoneyError('suspended', 'Account suspended');
    address = String(address || '').trim();
    const def = coinDef(coin);
    if (!def.re.test(address)) throw new MoneyError('bad_address', `That is not a valid ${def.name} address on ${def.network}`);
    if (!Number.isInteger(amount) || amount < config.minWithdraw) throw new MoneyError('bad_amount', 'Minimum withdrawal is $5.00');
    const fee = withdrawFeeOf(amount);
    const net = amount - fee;
    const coinAmt = live ? coinAmount(net, coin) : toCoin(net, coin);
    const id = await db.nextId('withdrawals');
    const held = await db.tx(async () => {
      const u = await db.users.findOne({ _id: user.id }, { projection: { review: 1, status: 1 } });
      if (u.status !== 'active') throw new MoneyError('suspended', 'Account suspended');
      const review = !!u.review;
      await db.withdrawals.insert({
        _id: id, user_id: user.id, coin, address, amount, fee, net, coin_amount: coinAmt,
        status: review ? 'review' : 'processing', txid: null, note: null, created_at: now(), completed_at: null,
      });
      const what = coinAmt ? `${coinAmt} ${label(coin)}` : `${label(coin)}`;
      await money.userEntry(user.id, -amount, 'withdrawal', `withdrawal:${id}`, `${what} to ${address.slice(0, 10)}...`);
      return review;
    });
    if (!held) scheduleWithdraw(id);
    hub.pushBalance(user.id);
    return withdrawalRow(id);
  }

  function scheduleWithdraw(id) {
    if (live) return; // staff send it and mark it sent in Admin
    setTimeout(() => ctx.track(completeWithdraw(id).catch((e) => console.error('withdrawal', id, e.message))), config.withdrawProcessMs).unref?.();
  }

  // Paper mode calls this on a timer with a made-up txid; in live mode staff
  // call it with the real one after sending the coins.
  async function completeWithdraw(id, sentTxid = null) {
    if (ctx.closed) return false;
    const w = await db.withdrawals.findOne({ _id: id });
    if (!w || (w.status !== 'processing' && w.status !== 'review')) return false;
    const u = await db.users.findOne({ _id: w.user_id }, { projection: { status: 1 } });
    if (u.status !== 'active') return false;
    const done = await db.tx(async () => {
      const r = await db.withdrawals.update(
        { _id: id, status: { $in: ['processing', 'review'] } },
        { $set: { status: 'completed', txid: sentTxid || txid(), completed_at: now() } },
      );
      if (!r.modifiedCount) return false;
      await money.house(w.fee, 'withdraw_fee', `withdrawal:${id}`);
      return true;
    });
    if (done) hub.toUser(w.user_id, { t: 'wallet', withdrawal: await withdrawalRow(id) });
    return done;
  }

  // Staff turn a withdrawal down: the full amount, fee included, goes back.
  async function rejectWithdraw(id, note) {
    const w = await db.withdrawals.findOne({ _id: id });
    if (!w) return false;
    const done = await db.tx(async () => {
      const r = await db.withdrawals.update(
        { _id: id, status: { $in: ['processing', 'review'] } },
        { $set: { status: 'rejected', note: note || 'Declined by staff', completed_at: now() } },
      );
      if (!r.modifiedCount) return false;
      await money.userEntry(w.user_id, w.amount, 'withdrawal_refund', `withdrawal:${id}`, note || 'Withdrawal declined');
      return true;
    });
    if (done) {
      hub.toUser(w.user_id, { t: 'wallet', withdrawal: await withdrawalRow(id) });
      hub.pushBalance(w.user_id);
    }
    return done;
  }

  // Held withdrawals of an account that was cleared go out; for a suspended
  // account they are forfeited.
  async function releaseHeld(userId) {
    for (const w of await db.withdrawals.find({ user_id: userId, status: 'review' }, { projection: { _id: 1 } })) {
      await db.withdrawals.update({ _id: w.id, status: 'review' }, { $set: { status: 'processing' } });
      scheduleWithdraw(w.id);
    }
  }
  async function forfeitHeld(userId) {
    for (const w of await db.withdrawals.find({ user_id: userId, status: { $in: ['review', 'processing'] } })) {
      await db.withdrawals.update({ _id: w.id }, { $set: { status: 'rejected', note: 'Account suspended', completed_at: now() } });
      await money.house(w.amount, 'forfeit', `withdrawal:${w.id}`);
    }
  }

  // --------------------------------------------------------------- staff

  // A payment that arrived but was never matched (wrong amount, wrong
  // network) is credited by hand against its txid, once.
  async function manualCredit(userId, amount, sentTxid, coin, note) {
    sentTxid = String(sentTxid || '').trim();
    if (!/^[A-Za-z0-9]{8,128}$/.test(sentTxid)) throw new MoneyError('bad_txid', 'Enter the transaction id');
    if (!Number.isInteger(amount) || amount < 1) throw new MoneyError('bad_amount', 'Enter an amount');
    const id = await db.nextId('deposits');
    await db.tx(async () => {
      const p = await db.payments.findOne({ _id: sentTxid }, { projection: { status: 1 } });
      if (p && (p.status === 'credited' || p.status === 'manual')) throw new MoneyError('duplicate', 'That transaction was already credited');
      const u = await db.users.findOne({ _id: userId }, { projection: { status: 1 } });
      if (!u) throw new MoneyError('no_user', 'Account not found');
      if (u.status !== 'active') throw new MoneyError('suspended', 'Reinstate the account first');
      const t = now();
      await db.deposits.insert({
        _id: id, kind: 'manual', user_id: userId, coin: coin || null, address: null, amount, coin_amount: null, credited: amount,
        status: 'credited', txid: sentTxid, txids: [sentTxid], confirmations: 2, required: 2, created_at: t, credited_at: t,
      });
      await db.payments.update({ _id: sentTxid }, {
        $set: { status: 'manual', invoice_id: id, user_id: userId, cents: amount, note: note || null, updated_at: t },
        $setOnInsert: { first_seen: t, coin: coin || null },
      }, { upsert: true });
      await money.userEntry(userId, amount, 'deposit', `deposit:${id}`, note || `Credited by staff, tx ${sentTxid.slice(0, 12)}`);
    });
    hub.toUser(userId, { t: 'wallet', deposit: await depositRow(id) });
    hub.pushBalance(userId);
    return depositRow(id);
  }

  async function staffView() {
    const names = async (rows) => {
      const m = new Map((await db.users.find({ _id: { $in: [...new Set(rows.map((r) => r.user_id).filter(Boolean))] } }, { projection: { username: 1, status: 1, review: 1 } })).map((u) => [u.id, u]));
      for (const r of rows) {
        const u = m.get(r.user_id);
        r.username = u?.username ?? null;
        r.user_status = u?.status ?? null;
        r.user_review = !!u?.review;
      }
      return rows;
    };
    const [withdrawals, deposits, problems] = await Promise.all([
      db.withdrawals.find({ status: { $in: ['processing', 'review'] } }, { sort: { _id: 1 }, limit: 200 }).then(names),
      db.deposits.find({ kind: { $in: ['bcon', 'manual'] } }, { projection: { ...DEPOSIT_FIELDS, user_id: 1 }, sort: { _id: -1 }, limit: 50 }).then(names),
      db.payments.find({ status: { $in: ['unmatched', 'held', 'pending'] } }, { sort: { updated_at: -1 }, limit: 50 }).then(names),
    ]);
    for (const w of withdrawals) {
      w.label = label(w.coin);
      w.network = coinDef(w.coin)?.network ?? null;
      w.coin_now = live ? coinAmount(w.net, w.coin) : null;
    }
    for (const d of deposits) d.label = label(d.coin);
    const s = live ? bcon.store : null;
    return {
      mode: config.payments,
      withdrawals, deposits, problems,
      store: live ? {
        connected: !!s, name: s?.name ?? null,
        chains: Object.entries(s?.chains || {}).map(([chain, c]) => ({ chain, wallet: c.address || (c.xpub ? `${c.xpub.slice(0, 12)}...` : null), callbackOk: !!c.callback?.includes(config.bconSecret) })),
        callbackPath: `/api/wallet/bcon/callback/${config.bconSecret}`,
      } : null,
    };
  }

  const DEPOSIT_FIELDS = { kind: 1, coin: 1, address: 1, amount: 1, credited: 1, coin_amount: 1, confirmations: 1, required: 1, status: 1, txid: 1, created_at: 1, expires_at: 1, credited_at: 1 };
  const WITHDRAWAL_FIELDS = { coin: 1, address: 1, amount: 1, fee: 1, net: 1, coin_amount: 1, status: 1, txid: 1, note: 1, created_at: 1, completed_at: 1 };
  const depositRow = (id) => db.deposits.findOne({ _id: id }, { projection: DEPOSIT_FIELDS });
  const withdrawalRow = (id) => db.withdrawals.findOne({ _id: id }, { projection: WITHDRAWAL_FIELDS });

  async function overview(userId) {
    const [deposits, withdrawals, ledger] = await Promise.all([
      db.deposits.find({ user_id: userId }, { projection: DEPOSIT_FIELDS, sort: { _id: -1 }, limit: 50 }),
      db.withdrawals.find({ user_id: userId }, { projection: WITHDRAWAL_FIELDS, sort: { _id: -1 }, limit: 50 }),
      db.ledger.find({ user_id: userId }, { projection: { kind: 1, amount: 1, balance_after: 1, ref: 1, note: 1, created_at: 1 }, sort: { _id: -1 }, limit: 100 }),
    ]);
    for (const d of deposits) d.label = label(d.coin);
    for (const w of withdrawals) w.label = label(w.coin);
    return { deposits, withdrawals, ledger };
  }

  return {
    live, bcon, coins, address, overview, resumePending, releaseHeld, forfeitHeld,
    deposit: (user, coin, amount) => (live ? openDeposit(user, coin, amount) : testDeposit(user, coin, amount)),
    invoice, notify, settle, sweep, withdraw, completeWithdraw, rejectWithdraw, manualCredit, staffView,
    stop: () => clearInterval(sweepTimer),
  };
}

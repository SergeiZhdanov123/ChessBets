import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { config } from './config.js';
import { MoneyError, withdrawFeeOf } from './money.js';
import { btcWallet, btcAddressOk, tronAddressOk, esplora, btcPrice, tronGrid, toUnits, satsToBtc } from './chain.js';

// Two modes. With PAYMENTS=paper (the default) nothing touches a real chain:
// deposit addresses are deliberately not valid on any network so nobody can
// lose real funds by sending to one, and rates are fixed reference prices.
// With PAYMENTS=crypto, deposits are real Bitcoin and USDT (Tron) paid into
// the site's own wallets, and withdrawals are sent by staff from Admin.
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
// A USDT amount handed to one request is not handed to another for this
// long, paid or not. Otherwise a player who sends the same amount again
// (from their wallet history, say) could pay into someone else's request.
const AMOUNT_RESERVED_MS = 7 * DAY;
// An unconfirmed bitcoin payment that stops showing up for this long was
// replaced or dropped by the network and is marked that way. If it comes
// back, it picks up where it was.
const BTC_GONE_MS = 30 * 60_000;
const EXPLORERS = {
  main: ['https://mempool.space/api', 'https://blockstream.info/api'],
  test: ['https://mempool.space/testnet/api', 'https://blockstream.info/testnet/api'],
};
const USDT = 'USDT-TRC20';
// A payment in one of these states has been dealt with and is never
// credited again.
const SETTLED = ['credited', 'held', 'manual', 'resolved'];

export function createWallet(ctx) {
  const { db, money, hub } = ctx;
  const now = () => Date.now();
  const txid = () => 'demo' + crypto.randomBytes(30).toString('hex');
  const live = config.payments === 'crypto';

  const btc = live && config.btcXpub ? btcWallet(config.btcXpub) : null;
  const btcApi = btc ? esplora(config.btcApis.length ? config.btcApis : EXPLORERS[btc.net]) : null;
  const price = btcPrice(config.btcPriceUrls);
  const tron = live && config.tronAddress ? tronGrid({ base: config.tronApi, apiKey: config.tronApiKey, contract: config.usdtContract }) : null;
  // Addresses belong to one xpub; a new xpub starts a fresh set.
  const btcKey = btc ? `btc:${crypto.createHash('sha256').update(config.btcXpub).digest('hex').slice(0, 12)}` : null;
  const watch = { lastScan: null, lastError: null };

  function coins() {
    if (!live) return coinList();
    const out = [];
    if (btc) {
      out.push({
        code: 'BTC', label: 'BTC', name: 'Bitcoin', network: btc.net === 'main' ? 'Bitcoin' : 'Bitcoin testnet', decimals: 8,
        confirmations: config.btcConfirmations, rate: price.cached, ownAddress: true,
      });
    }
    if (tron) out.push({ code: USDT, label: 'USDT', name: 'Tether', network: 'Tron (TRC-20)', decimals: 2, confirmations: 1, rate: 1, stable: true, ownAddress: false });
    return out;
  }
  const coinInfo = (code) => coins().find((c) => c.code === code);
  const label = (code) => coinInfo(code)?.label || String(code || '').split('-')[0];

  function checkCoin(code) {
    if (coinInfo(code)) return;
    throw new MoneyError('bad_coin', 'Unsupported currency');
  }
  function validAddress(code, a) {
    if (!live) return COINS[code].re.test(a);
    if (code === 'BTC') return btcAddressOk(a, btc.net);
    if (code === USDT) return tronAddressOk(a);
    return false;
  }
  function coinAmount(cents, code) {
    const c = coinInfo(code);
    return c?.rate ? (cents / 100 / c.rate).toFixed(c.decimals) : null;
  }
  const qr = (text) => QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#0f212eff', light: '#ffffffff' } });

  // ---------------------------------------------------------- addresses

  // Paper: one made-up address per coin. Live bitcoin: the next address
  // from the xpub, kept for that player from then on.
  async function address(userId, coin) {
    checkCoin(coin);
    if (live && coin !== 'BTC') throw new MoneyError('bad_request', 'Choose an amount to get a deposit address');
    if (live) return ctx.userLock(userId, () => btcAddress(userId));
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

  async function btcAddress(userId) {
    const t = now();
    let row = await db.deposit_addresses.findOne({ user_id: userId, coin: btcKey });
    if (row) {
      await db.deposit_addresses.update({ _id: row.id }, { $set: { last_shown_at: t } });
    } else {
      const index = config.btcStartIndex + (await db.nextId(btcKey)) - 1;
      row = { address: btc.address(index), index };
      await db.deposit_addresses.insert({ user_id: userId, coin: btcKey, address: row.address, index, created_at: t, last_shown_at: t });
    }
    return {
      coin: 'BTC', address: row.address, qr: await qr(`bitcoin:${row.address}`),
      confirmations: config.btcConfirmations, minimum: config.btcMinCredit, rate: price.cached,
    };
  }

  // ------------------------------------------------------- paper deposits

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

  // ------------------------------------------------- USDT deposit requests

  // Everyone pays USDT into the same Tron address, so each open request
  // gets its own exact amount: $25 becomes 25.00, the next $25 25.01.
  async function openInvoice(user, coin, amount) {
    checkCoin(coin);
    if (coin !== USDT) throw new MoneyError('bad_request', 'Bitcoin deposits use your address, any amount');
    if (user.status !== 'active') throw new MoneyError('suspended', 'Account suspended');
    if (!Number.isInteger(amount) || amount < config.cryptoMinDeposit) throw new MoneyError('bad_amount', `Minimum deposit is $${(config.cryptoMinDeposit / 100).toFixed(2)}`);
    if (amount > config.cryptoMaxDeposit) throw new MoneyError('bad_amount', `Maximum deposit is $${(config.cryptoMaxDeposit / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    const mine = await db.deposits.find(
      { user_id: user.id, kind: 'invoice', status: 'awaiting', expires_at: { $gt: now() } },
      { projection: { coin: 1, amount: 1 } },
    );
    const same = mine.find((d) => d.coin === coin && d.amount === amount);
    if (same) return invoice(user.id, same.id);
    if (mine.length >= config.openInvoices) throw new MoneyError('too_many', 'You have 3 deposits waiting for payment. Pay one or wait for it to expire.');

    const id = await db.nextId('deposits');
    // db.tx runs one at a time, so two requests can't pick the same amount.
    await db.tx(async () => {
      const taken = new Set((await db.deposits.find(
        { kind: 'invoice', coin, created_at: { $gt: now() - AMOUNT_RESERVED_MS } },
        { projection: { coin_amount: 1 } },
      )).map((d) => d.coin_amount));
      let cents = amount;
      while (taken.has((cents / 100).toFixed(2)) && cents < amount + 100) cents++;
      if (taken.has((cents / 100).toFixed(2))) throw new MoneyError('busy', 'Too many deposits of this amount are open. Try a slightly different amount.');
      const t = now();
      await db.deposits.insert({
        _id: id, kind: 'invoice', user_id: user.id, coin, address: config.tronAddress, amount, coin_amount: (cents / 100).toFixed(2),
        credited: 0, status: 'awaiting', txid: null, txids: [], confirmations: 0, required: 1,
        created_at: t, expires_at: t + config.invoiceMs, credited_at: null,
      });
    });
    return invoice(user.id, id);
  }

  async function invoice(userId, id) {
    const d = await db.deposits.findOne({ _id: id, user_id: userId }, { projection: DEPOSIT_FIELDS });
    if (!d) throw Object.assign(new MoneyError('not_found', 'Deposit not found'), { status: 404 });
    return { ...d, label: label(d.coin), network: coinInfo(d.coin)?.network, qr: d.address ? await qr(d.address) : null };
  }

  // ------------------------------------------------------------ watching

  // One scan per address (or of the Tron wallet) at a time; the sweep and a
  // player's "check now" can overlap.
  const scanning = new Map();
  function once(key, fn) {
    let p = scanning.get(key);
    if (!p) {
      p = fn().finally(() => scanning.delete(key));
      scanning.set(key, p);
    }
    return p;
  }

  const scanBtc = (row, tip) => once(`btc|${row.address}`, async () => {
    const seen = await btcApi.received(row.address);
    for (const t of seen) {
      const id = `btc:${t.txid}:${row.address}`;
      const known = await db.payments.findOne({ _id: id });
      if (known && SETTLED.includes(known.status)) continue;
      const conf = t.height ? Math.max(0, tip - t.height + 1) : 0;
      if (conf < config.btcConfirmations) await btcSeen(row, t, id, known, conf);
      else await btcCredit(row, t, id, known);
    }
    await btcGone(row, new Set(seen.map((t) => t.txid)));
  });

  // Payments shown as on their way that the explorer no longer lists.
  async function btcGone(row, present) {
    const t = now();
    for (const d of await db.deposits.find({ kind: 'chain', address: row.address, status: 'confirming' })) {
      if (present.has(d.txid)) continue;
      if (!d.missing_since) { await db.deposits.update({ _id: d.id, status: 'confirming' }, { $set: { missing_since: t } }); continue; }
      if (t - d.missing_since < BTC_GONE_MS) continue;
      const r = await db.deposits.update({ _id: d.id, status: 'confirming' }, {
        $set: { status: 'dropped', note: 'The bitcoin network dropped or replaced this payment before it confirmed. Nothing was credited.' },
      });
      if (!r.modifiedCount) continue;
      await db.payments.update({ _id: `btc:${d.txid}:${row.address}`, status: 'pending' }, { $set: { status: 'dropped', updated_at: t } });
      hub.toUser(row.user_id, { t: 'wallet', deposit: await depositRow(d.id) });
    }
  }

  // Not confirmed yet: show it to the player as on its way.
  async function btcSeen(row, t, id, known, conf) {
    if (known?.deposit_id) {
      // A payment marked dropped that the network brought back is live again.
      const r = await db.deposits.update(
        { _id: known.deposit_id, $or: [{ confirmations: { $ne: conf } }, { status: 'dropped' }, { missing_since: { $ne: null } }] },
        { $set: { confirmations: conf, status: 'confirming', missing_since: null, note: null } },
      );
      if (known.status === 'dropped') await db.payments.update({ _id: id }, { $set: { status: 'pending', updated_at: now() } });
      if (r.modifiedCount) hub.toUser(row.user_id, { t: 'wallet', deposit: await depositRow(known.deposit_id) });
      return;
    }
    const depId = await db.nextId('deposits');
    const estimate = price.cached ? Math.floor((t.sats * price.cached) / 1e6) : 0;
    await db.deposits.insert({
      _id: depId, kind: 'chain', user_id: row.user_id, coin: 'BTC', address: row.address, amount: estimate, coin_amount: satsToBtc(t.sats),
      credited: 0, status: 'confirming', txid: t.txid, txids: [t.txid], confirmations: conf, required: config.btcConfirmations,
      created_at: now(), credited_at: null,
    });
    await record(id, { txid: t.txid, coin: 'BTC', address: row.address, sum: satsToBtc(t.sats) }, row.user_id, depId, 'pending');
    hub.toUser(row.user_id, { t: 'wallet', deposit: await depositRow(depId) });
  }

  // Confirmed: credited at the bitcoin price right now.
  async function btcCredit(row, t, id, known) {
    const usd = await price.get({ fresh: true });
    const cents = Math.floor((t.sats * usd) / 1e6);
    const depId = known?.deposit_id ?? (await db.nextId('deposits'));
    const tx = { txid: t.txid, coin: 'BTC', address: row.address, sum: satsToBtc(t.sats) };
    const status = await settle(id, tx, row.user_id, depId, cents, async (s) => {
      const set = {
        status: s === 'credited' ? 'credited' : 'held', amount: cents, credited: s === 'credited' ? cents : 0,
        confirmations: config.btcConfirmations, credited_at: now(), note: s === 'small' ? `Below the ${fmtUsd(config.btcMinCredit)} minimum` : null,
      };
      if (known?.deposit_id) await db.deposits.update({ _id: depId }, { $set: set });
      else {
        await db.deposits.insert({
          _id: depId, kind: 'chain', user_id: row.user_id, coin: 'BTC', address: row.address, coin_amount: tx.sum, txid: t.txid, txids: [t.txid],
          required: config.btcConfirmations, created_at: now(), ...set,
        });
      }
    }, `${tx.sum} BTC at ${fmtUsd(Math.round(usd * 100))}`);
    if (status) hub.toUser(row.user_id, { t: 'wallet', deposit: await depositRow(depId) });
  }

  const scanTron = () => once('tron', async () => {
    const open = await db.deposits.find(
      { kind: 'invoice', coin: USDT, status: { $in: ['awaiting', 'expired'] }, created_at: { $gt: now() - 3 * DAY } },
      { sort: { _id: 1 } },
    );
    if (!open.length) return;
    const since = Math.min(...open.map((d) => d.created_at)) - 10 * 60_000;
    for (const t of await tron.received(config.tronAddress, since)) {
      const id = `trx:${t.txid}`;
      if (await db.payments.findOne({ _id: id }, { projection: { _id: 1 } })) continue;
      const sum = (Number(t.micro) / 1e6).toFixed(6).replace(/0{1,4}$/, '');
      const inv = open.find((d) => d.status !== 'credited' && toUnits(d.coin_amount, 6) === t.micro && t.at >= d.created_at - 2 * 60_000);
      const tx = { txid: t.txid, coin: USDT, address: config.tronAddress, sum };
      if (!inv) {
        // Dust is how address-poisoning scams start; only list real money.
        if (t.micro >= 1_000_000n) await record(id, tx, null, null, 'unmatched', 'No open deposit for this exact amount');
        continue;
      }
      inv.status = 'credited';
      const status = await settle(id, tx, inv.user_id, inv.id, inv.amount, (s) => db.deposits.update({ _id: inv.id }, {
        $set: { status: s === 'credited' ? 'credited' : 'held', credited: s === 'credited' ? inv.amount : 0, txid: t.txid, confirmations: 1, credited_at: now() },
        $addToSet: { txids: t.txid },
      }), `${sum} USDT`);
      if (status) hub.toUser(inv.user_id, { t: 'wallet', deposit: await depositRow(inv.id) });
    }
  });

  // Credit one payment, exactly once. Money that reaches a suspended
  // account is held for staff, not credited or forfeited.
  async function settle(id, tx, userId, depId, cents, markDeposit, note) {
    const status = await db.tx(async () => {
      const done = await db.payments.findOne({ _id: id }, { projection: { status: 1 } });
      if (done && SETTLED.includes(done.status)) return null;
      // Staff may already have credited this txid by hand.
      if (await db.payments.findOne({ txid: tx.txid, status: 'manual' }, { projection: { _id: 1 } })) {
        await record(id, tx, userId, depId, 'resolved', 'Already credited by staff');
        return null;
      }
      if (cents < (tx.coin === 'BTC' ? config.btcMinCredit : 1)) {
        await record(id, tx, userId, depId, 'held', `Below the ${fmtUsd(config.btcMinCredit)} minimum`, cents);
        await markDeposit('small');
        return 'held';
      }
      const u = await db.users.findOne({ _id: userId }, { projection: { status: 1 } });
      const s = u?.status === 'active' ? 'credited' : 'held';
      await record(id, tx, userId, depId, s, s === 'held' ? 'Account suspended' : null, cents);
      if (s === 'credited') await money.userEntry(userId, cents, 'deposit', `deposit:${depId}`, `${note}, tx ${tx.txid.slice(0, 12)}`);
      await markDeposit(s);
      return s;
    });
    if (status === 'credited') hub.pushBalance(userId);
    return status;
  }

  function record(id, tx, userId, depId, status, note = null, cents = null) {
    const t = now();
    return db.payments.update({ _id: id }, {
      $set: { status, note, txid: tx.txid, coin: tx.coin, address: tx.address, sum: tx.sum, user_id: userId, deposit_id: depId, cents, updated_at: t },
      $setOnInsert: { first_seen: t },
    }, { upsert: true });
  }

  // Looks for new payments: every bitcoin address shown in the last three
  // days or with a payment confirming, and the Tron wallet while any USDT
  // request is open.
  let sweeping = null;
  function sweep() {
    sweeping ??= (async () => {
      if (ctx.closed) return;
      try {
        await db.deposits.updateMany({ kind: 'invoice', status: 'awaiting', expires_at: { $lt: now() } }, { $set: { status: 'expired' } });
        if (btc) {
          await price.get().catch(() => {});
          const confirming = await db.deposits.find({ kind: 'chain', status: 'confirming' }, { projection: { address: 1 } });
          const rows = await db.deposit_addresses.find(
            { coin: btcKey, $or: [{ last_shown_at: { $gt: now() - 3 * DAY } }, { address: { $in: confirming.map((d) => d.address) } }] },
            { sort: { last_shown_at: -1 }, limit: 200 },
          );
          if (rows.length) {
            const tip = await btcApi.tip();
            for (const row of rows) {
              if (ctx.closed) return;
              await scanBtc(row, tip);
            }
          }
        }
        if (tron) await scanTron();
        watch.lastScan = now();
        watch.lastError = null;
      } catch (e) {
        watch.lastError = `${new Date().toISOString()} ${e.message}`;
        throw e;
      }
    })().finally(() => { sweeping = null; });
    return sweeping;
  }

  // A player waiting on the deposit screen asks for a look now rather than
  // at the next sweep.
  const lastLook = new Map();
  async function refresh(userId) {
    if (!live) return;
    const t = now();
    if (t - (lastLook.get(userId) || 0) < 10_000) return;
    lastLook.set(userId, t);
    if (lastLook.size > 5000) lastLook.clear();
    if (btc) {
      const row = await db.deposit_addresses.findOne({ user_id: userId, coin: btcKey });
      if (row) await scanBtc(row, await btcApi.tip());
    }
    if (tron && (await db.deposits.count({ user_id: userId, kind: 'invoice', status: { $in: ['awaiting', 'expired'] }, created_at: { $gt: t - 3 * DAY } }))) {
      await scanTron();
    }
  }

  let sweepTimer = null;
  async function resumePending() {
    if (live) {
      const parts = [btc && `bitcoin ${btc.net === 'main' ? 'mainnet' : 'testnet'} (${btc.type}, first address ${btc.address(config.btcStartIndex)})`, tron && `USDT on Tron to ${config.tronAddress}`].filter(Boolean);
      console.log(`  crypto payments: ${parts.join('; ')}`);
      sweepTimer = setInterval(() => ctx.track(sweep().catch((e) => console.error('crypto sweep', e.message))), config.cryptoPollMs);
      sweepTimer.unref?.();
      ctx.track(sweep().catch((e) => console.error('crypto sweep', e.message)));
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
    const c = live ? coinInfo(coin) : COINS[coin];
    if (!validAddress(coin, address)) throw new MoneyError('bad_address', `That is not a valid ${c.name} address on ${c.network}`);
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
      const what = coinAmt ? `${coinAmt} ${label(coin)}` : label(coin);
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
    // Staff recording coins they already sent is always allowed: the money
    // is gone whatever happened to the account since.
    if (u.status !== 'active' && !(live && sentTxid)) return false;
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
  // For a suspended account it is forfeited instead, like the rest of the
  // balance (and comes back if the account is reinstated with its balance).
  async function rejectWithdraw(id, note) {
    const w = await db.withdrawals.findOne({ _id: id });
    if (!w) return false;
    const done = await db.tx(async () => {
      const u = await db.users.findOne({ _id: w.user_id }, { projection: { status: 1 } });
      const suspended = u?.status === 'suspended';
      const r = await db.withdrawals.update(
        { _id: id, status: { $in: ['processing', 'review'] } },
        { $set: { status: 'rejected', note: suspended ? 'Account suspended' : note || 'Declined by staff', completed_at: now() } },
      );
      if (!r.modifiedCount) return false;
      if (suspended) {
        await money.house(w.amount, 'forfeit', `withdrawal:${id}`);
        await db.users.update({ _id: w.user_id }, { $inc: { forfeited: w.amount } });
      } else {
        await money.userEntry(w.user_id, w.amount, 'withdrawal_refund', `withdrawal:${id}`, note || 'Withdrawal declined');
      }
      return true;
    });
    if (done) {
      hub.toUser(w.user_id, { t: 'wallet', withdrawal: await withdrawalRow(id) });
      hub.pushBalance(w.user_id);
    }
    return done;
  }

  // Held withdrawals of an account that was cleared go out; for a suspended
  // account they are forfeited. With real payments, open withdrawals of a
  // suspended account are left for staff instead: the coins may already
  // have been sent without being marked, so staff either mark it sent or
  // decline it, which forfeits it. Returns the amount forfeited now.
  async function releaseHeld(userId) {
    for (const w of await db.withdrawals.find({ user_id: userId, status: 'review' }, { projection: { _id: 1 } })) {
      await db.withdrawals.update({ _id: w.id, status: 'review' }, { $set: { status: 'processing' } });
      scheduleWithdraw(w.id);
    }
  }
  async function forfeitHeld(userId) {
    let total = 0;
    for (const w of await db.withdrawals.find({ user_id: userId, status: { $in: ['review', 'processing'] } })) {
      if (live) {
        await db.withdrawals.update({ _id: w.id }, { $set: { note: 'Account suspended' } });
        continue;
      }
      await db.withdrawals.update({ _id: w.id }, { $set: { status: 'rejected', note: 'Account suspended', completed_at: now() } });
      await money.house(w.amount, 'forfeit', `withdrawal:${w.id}`);
      total += w.amount;
    }
    return total;
  }

  // ---------------------------------------------------------------- staff

  // A payment that arrived but was never matched (wrong amount, below the
  // minimum, a suspended account later reinstated) is credited by hand
  // against its txid, once.
  async function manualCredit(userId, amount, sentTxid, coin, note) {
    sentTxid = String(sentTxid || '').trim();
    if (!/^[A-Za-z0-9]{8,128}$/.test(sentTxid)) throw new MoneyError('bad_txid', 'Enter the transaction id');
    if (!Number.isInteger(amount) || amount < 1) throw new MoneyError('bad_amount', 'Enter an amount');
    const id = await db.nextId('deposits');
    await db.tx(async () => {
      if (await db.payments.findOne({ txid: sentTxid, status: { $in: ['credited', 'manual'] } }, { projection: { _id: 1 } })) {
        throw new MoneyError('duplicate', 'That transaction was already credited');
      }
      const u = await db.users.findOne({ _id: userId }, { projection: { status: 1 } });
      if (!u) throw new MoneyError('no_user', 'Account not found');
      if (u.status !== 'active') throw new MoneyError('suspended', 'Reinstate the account first');
      const t = now();
      await db.deposits.insert({
        _id: id, kind: 'manual', user_id: userId, coin: coin || null, address: null, amount, coin_amount: null, credited: amount,
        status: 'credited', txid: sentTxid, txids: [sentTxid], confirmations: 0, required: 0, created_at: t, credited_at: t,
      });
      await db.payments.updateMany({ txid: sentTxid, status: { $in: ['unmatched', 'held', 'pending'] } }, { $set: { status: 'resolved', updated_at: t } });
      await db.payments.insert({ _id: `manual:${sentTxid}`, status: 'manual', txid: sentTxid, coin: coin || null, user_id: userId, deposit_id: id, cents: amount, note: note || null, first_seen: t, updated_at: t });
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
      db.deposits.find({ kind: { $in: ['chain', 'invoice', 'manual'] } }, { projection: { ...DEPOSIT_FIELDS, user_id: 1 }, sort: { _id: -1 }, limit: 50 }).then(names),
      db.payments.find({ status: { $in: ['unmatched', 'held'] } }, { sort: { updated_at: -1 }, limit: 50 }).then(names),
    ]);
    for (const w of withdrawals) {
      w.label = label(w.coin);
      w.network = coinInfo(w.coin)?.network ?? null;
      w.coin_now = live ? coinAmount(w.net, w.coin) : null;
    }
    for (const d of deposits) d.label = label(d.coin);

    let wallets = null;
    if (live) {
      wallets = { lastScan: watch.lastScan, lastError: watch.lastError, price: price.cached, btc: null, tron: tron ? { address: config.tronAddress } : null };
      if (btc) {
        const assigned = await db.deposit_addresses.find({ coin: btcKey }, { projection: { index: 1, address: 1 } });
        const used = new Set((await db.deposits.find({ kind: 'chain', address: { $in: assigned.map((a) => a.address) } }, { projection: { address: 1 } })).map((d) => d.address));
        const top = assigned.reduce((m, a) => Math.max(m, a.index), config.btcStartIndex - 1);
        const topUsed = assigned.filter((a) => used.has(a.address)).reduce((m, a) => Math.max(m, a.index), config.btcStartIndex - 1);
        wallets.btc = {
          network: btc.net, type: btc.type, xpub: `${config.btcXpub.slice(0, 8)}...${config.btcXpub.slice(-6)}`,
          firstAddress: btc.address(config.btcStartIndex), firstIndex: config.btcStartIndex, assigned: assigned.length, highestIndex: top,
          // Wallet apps stop looking 20 unused addresses past the last used
          // one, so coins further out don't show until the limit is raised.
          gap: top - topUsed,
        };
      }
    }
    return { mode: config.payments, withdrawals, deposits, problems, wallets };
  }

  const DEPOSIT_FIELDS = { kind: 1, coin: 1, address: 1, amount: 1, credited: 1, coin_amount: 1, confirmations: 1, required: 1, status: 1, txid: 1, note: 1, created_at: 1, expires_at: 1, credited_at: 1 };
  const WITHDRAWAL_FIELDS = { coin: 1, address: 1, amount: 1, fee: 1, net: 1, coin_amount: 1, status: 1, txid: 1, note: 1, created_at: 1, completed_at: 1 };
  const depositRow = async (id) => {
    const d = await db.deposits.findOne({ _id: id }, { projection: DEPOSIT_FIELDS });
    if (d) d.label = label(d.coin);
    return d;
  };
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
    live, coins, address, overview, resumePending, releaseHeld, forfeitHeld, refresh, sweep,
    deposit: (user, coin, amount) => (live ? openInvoice(user, coin, amount) : testDeposit(user, coin, amount)),
    invoice, withdraw, completeWithdraw, rejectWithdraw, manualCredit, staffView,
    stop: () => clearInterval(sweepTimer),
  };
}

const fmtUsd = (cents) => `$${(cents / 100).toFixed(2)}`;

import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { config } from './config.js';
import { MoneyError, withdrawFeeOf } from './money.js';

// Paper money: nothing here touches a real chain. Deposit addresses are
// deliberately not valid on any network so nobody can lose real funds by
// sending to one. Rates are fixed reference prices used only to show a coin
// amount next to the dollar figure.
export const COINS = {
  BTC: { name: 'Bitcoin', network: 'Bitcoin', rate: 100_000, decimals: 8, confirmations: 2, re: /^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/ },
  ETH: { name: 'Ethereum', network: 'Ethereum', rate: 3_500, decimals: 6, confirmations: 3, re: /^0x[a-fA-F0-9]{40}$/ },
  USDT: { name: 'Tether', network: 'Ethereum (ERC-20)', rate: 1, decimals: 2, confirmations: 3, re: /^0x[a-fA-F0-9]{40}$/ },
  USDC: { name: 'USD Coin', network: 'Ethereum (ERC-20)', rate: 1, decimals: 2, confirmations: 3, re: /^0x[a-fA-F0-9]{40}$/ },
  SOL: { name: 'Solana', network: 'Solana', rate: 180, decimals: 4, confirmations: 1, re: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ },
  LTC: { name: 'Litecoin', network: 'Litecoin', rate: 90, decimals: 6, confirmations: 2, re: /^(ltc1[a-z0-9]{25,62}|[LM3][a-km-zA-HJ-NP-Z1-9]{26,33})$/ },
  DOGE: { name: 'Dogecoin', network: 'Dogecoin', rate: 0.2, decimals: 2, confirmations: 2, re: /^D[5-9A-HJ-NP-U][1-9A-HJ-NP-Za-km-z]{32}$/ },
};

export const coinList = () => Object.entries(COINS).map(([code, c]) => ({ code, name: c.name, network: c.network, rate: c.rate, decimals: c.decimals, confirmations: c.confirmations }));

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

export function createWallet(ctx) {
  const { db, money, hub } = ctx;
  const now = () => Date.now();
  const txid = () => 'demo' + crypto.randomBytes(30).toString('hex');

  function checkCoin(coin) {
    if (!COINS[coin]) throw new MoneyError('bad_coin', 'Unsupported currency');
  }

  async function address(userId, coin) {
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
    const qr = await QRCode.toString(row.address, { type: 'svg', margin: 1, color: { dark: '#0f212eff', light: '#ffffffff' } });
    return { coin, address: row.address, qr };
  }

  // Simulates an incoming transfer: it shows up unconfirmed, ticks through
  // confirmations, then credits the balance.
  async function testDeposit(user, coin, amount) {
    checkCoin(coin);
    if (user.status !== 'active') throw new MoneyError('suspended', 'Account suspended');
    if (!Number.isInteger(amount) || amount < 100) throw new MoneyError('bad_amount', 'Minimum deposit is $1.00');
    if (amount > config.maxTestDeposit) throw new MoneyError('bad_amount', 'Maximum test deposit is $1,000.00');
    const today = await db.deposits.sum('$amount', { user_id: user.id, created_at: { $gt: now() - 86_400_000 } });
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

  async function resumePending() {
    for (const d of await db.deposits.find({ status: 'pending' }, { projection: { _id: 1 } })) scheduleConfirm(d.id);
    for (const w of await db.withdrawals.find({ status: 'processing' }, { projection: { _id: 1 } })) scheduleWithdraw(w.id);
  }

  async function withdraw(user, coin, address, amount) {
    checkCoin(coin);
    if (user.status !== 'active') throw new MoneyError('suspended', 'Account suspended');
    address = String(address || '').trim();
    if (!COINS[coin].re.test(address)) throw new MoneyError('bad_address', `That is not a valid ${COINS[coin].name} address`);
    if (!Number.isInteger(amount) || amount < config.minWithdraw) throw new MoneyError('bad_amount', 'Minimum withdrawal is $5.00');
    const fee = withdrawFeeOf(amount);
    const net = amount - fee;
    const id = await db.nextId('withdrawals');
    const held = await db.tx(async () => {
      const u = await db.users.findOne({ _id: user.id }, { projection: { review: 1, status: 1 } });
      if (u.status !== 'active') throw new MoneyError('suspended', 'Account suspended');
      const review = !!u.review;
      await db.withdrawals.insert({
        _id: id, user_id: user.id, coin, address, amount, fee, net, coin_amount: toCoin(net, coin),
        status: review ? 'review' : 'processing', txid: null, note: null, created_at: now(), completed_at: null,
      });
      await money.userEntry(user.id, -amount, 'withdrawal', `withdrawal:${id}`, `${toCoin(net, coin)} ${coin} to ${address.slice(0, 10)}...`);
      return review;
    });
    if (!held) scheduleWithdraw(id);
    hub.pushBalance(user.id);
    return withdrawalRow(id);
  }

  function scheduleWithdraw(id) {
    setTimeout(() => ctx.track(completeWithdraw(id).catch((e) => console.error('withdrawal', id, e.message))), config.withdrawProcessMs).unref?.();
  }

  async function completeWithdraw(id) {
    if (ctx.closed) return;
    const w = await db.withdrawals.findOne({ _id: id });
    if (!w || (w.status !== 'processing' && w.status !== 'review')) return;
    const u = await db.users.findOne({ _id: w.user_id }, { projection: { status: 1 } });
    if (u.status !== 'active') return;
    const done = await db.tx(async () => {
      const r = await db.withdrawals.update(
        { _id: id, status: { $in: ['processing', 'review'] } },
        { $set: { status: 'completed', txid: txid(), completed_at: now() } },
      );
      if (!r.modifiedCount) return false;
      await money.house(w.fee, 'withdraw_fee', `withdrawal:${id}`);
      return true;
    });
    if (done) hub.toUser(w.user_id, { t: 'wallet', withdrawal: await withdrawalRow(id) });
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

  const DEPOSIT_FIELDS = { coin: 1, amount: 1, coin_amount: 1, confirmations: 1, required: 1, status: 1, txid: 1, created_at: 1, credited_at: 1 };
  const WITHDRAWAL_FIELDS = { coin: 1, address: 1, amount: 1, fee: 1, net: 1, coin_amount: 1, status: 1, txid: 1, created_at: 1, completed_at: 1 };
  const depositRow = (id) => db.deposits.findOne({ _id: id }, { projection: DEPOSIT_FIELDS });
  const withdrawalRow = (id) => db.withdrawals.findOne({ _id: id }, { projection: WITHDRAWAL_FIELDS });

  async function overview(userId) {
    const [deposits, withdrawals, ledger] = await Promise.all([
      db.deposits.find({ user_id: userId }, { projection: DEPOSIT_FIELDS, sort: { _id: -1 }, limit: 50 }),
      db.withdrawals.find({ user_id: userId }, { projection: WITHDRAWAL_FIELDS, sort: { _id: -1 }, limit: 50 }),
      db.ledger.find({ user_id: userId }, { projection: { kind: 1, amount: 1, balance_after: 1, ref: 1, note: 1, created_at: 1 }, sort: { _id: -1 }, limit: 100 }),
    ]);
    return { deposits, withdrawals, ledger };
  }

  return { address, testDeposit, withdraw, overview, resumePending, releaseHeld, forfeitHeld, completeWithdraw };
}

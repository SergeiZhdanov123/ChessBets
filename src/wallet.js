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
    let row = db.get('SELECT address FROM deposit_addresses WHERE user_id = ? AND coin = ?', userId, coin);
    if (!row) {
      const addr = demoAddress(coin);
      db.run('INSERT INTO deposit_addresses (user_id, coin, address, created_at) VALUES (?,?,?,?)', userId, coin, addr, now());
      row = { address: addr };
    }
    const qr = await QRCode.toString(row.address, { type: 'svg', margin: 1, color: { dark: '#0f212eff', light: '#ffffffff' } });
    return { coin, address: row.address, qr };
  }

  // Simulates an incoming transfer: it shows up unconfirmed, ticks through
  // confirmations, then credits the balance.
  function testDeposit(user, coin, amount) {
    checkCoin(coin);
    if (user.status !== 'active') throw new MoneyError('suspended', 'Account suspended');
    if (!Number.isInteger(amount) || amount < 100) throw new MoneyError('bad_amount', 'Minimum deposit is $1.00');
    if (amount > config.maxTestDeposit) throw new MoneyError('bad_amount', 'Maximum test deposit is $1,000.00');
    const today = db.get("SELECT COALESCE(SUM(amount),0) s FROM deposits WHERE user_id = ? AND created_at > ?", user.id, now() - 86_400_000).s;
    if (today + amount > config.dailyTestDepositCap) throw new MoneyError('cap', 'Daily test deposit limit is $10,000.00');
    const addr = db.get('SELECT address FROM deposit_addresses WHERE user_id = ? AND coin = ?', user.id, coin);
    if (!addr) throw new MoneyError('no_address', 'Generate a deposit address first');
    const c = COINS[coin];
    const r = db.run(
      'INSERT INTO deposits (user_id, coin, address, amount, coin_amount, required, status, txid, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      user.id, coin, addr.address, amount, toCoin(amount, coin), c.confirmations, 'pending', txid(), now(),
    );
    const id = Number(r.lastInsertRowid);
    scheduleConfirm(id);
    return depositRow(id);
  }

  function scheduleConfirm(id) {
    setTimeout(() => confirmStep(id), config.depositConfirmMs).unref?.();
  }

  function confirmStep(id) {
    if (ctx.closed) return;
    const d = db.get('SELECT * FROM deposits WHERE id = ?', id);
    if (!d || d.status !== 'pending') return;
    const conf = d.confirmations + 1;
    if (conf < d.required) {
      db.run('UPDATE deposits SET confirmations = ? WHERE id = ?', conf, id);
      hub.toUser(d.user_id, { t: 'wallet', deposit: depositRow(id) });
      scheduleConfirm(id);
      return;
    }
    const u = db.get('SELECT status FROM users WHERE id = ?', d.user_id);
    db.tx(() => {
      if (u.status !== 'active') {
        // Funds sent to a suspended account are forfeited like the rest.
        db.run("UPDATE deposits SET confirmations = ?, status = 'forfeited', credited_at = ? WHERE id = ?", conf, now(), id);
        money.house(d.amount, 'forfeit', `deposit:${id}`);
        return;
      }
      db.run("UPDATE deposits SET confirmations = ?, status = 'credited', credited_at = ? WHERE id = ?", conf, now(), id);
      money.userEntry(d.user_id, d.amount, 'deposit', `deposit:${id}`, `${d.coin_amount} ${d.coin}`);
    });
    hub.toUser(d.user_id, { t: 'wallet', deposit: depositRow(id) });
    hub.pushBalance(d.user_id);
  }

  function resumePending() {
    for (const d of db.all("SELECT id FROM deposits WHERE status = 'pending'")) scheduleConfirm(d.id);
    for (const w of db.all("SELECT id FROM withdrawals WHERE status = 'processing'")) scheduleWithdraw(w.id);
  }

  function withdraw(user, coin, address, amount) {
    checkCoin(coin);
    if (user.status !== 'active') throw new MoneyError('suspended', 'Account suspended');
    address = String(address || '').trim();
    if (!COINS[coin].re.test(address)) throw new MoneyError('bad_address', `That is not a valid ${COINS[coin].name} address`);
    if (!Number.isInteger(amount) || amount < config.minWithdraw) throw new MoneyError('bad_amount', 'Minimum withdrawal is $5.00');
    const fee = withdrawFeeOf(amount);
    const net = amount - fee;
    const held = !!db.get('SELECT review FROM users WHERE id = ?', user.id)?.review;
    const id = db.tx(() => {
      const r = db.run(
        'INSERT INTO withdrawals (user_id, coin, address, amount, fee, net, coin_amount, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        user.id, coin, address, amount, fee, net, toCoin(net, coin), held ? 'review' : 'processing', now(),
      );
      const wid = Number(r.lastInsertRowid);
      money.userEntry(user.id, -amount, 'withdrawal', `withdrawal:${wid}`, `${toCoin(net, coin)} ${coin} to ${address.slice(0, 10)}...`);
      return wid;
    });
    if (!held) scheduleWithdraw(id);
    hub.pushBalance(user.id);
    return withdrawalRow(id);
  }

  function scheduleWithdraw(id) {
    setTimeout(() => completeWithdraw(id), config.withdrawProcessMs).unref?.();
  }

  function completeWithdraw(id) {
    if (ctx.closed) return;
    const w = db.get('SELECT * FROM withdrawals WHERE id = ?', id);
    if (!w || (w.status !== 'processing' && w.status !== 'review')) return;
    const u = db.get('SELECT status FROM users WHERE id = ?', w.user_id);
    if (u.status !== 'active') return;
    db.tx(() => {
      db.run("UPDATE withdrawals SET status = 'completed', txid = ?, completed_at = ? WHERE id = ?", txid(), now(), id);
      money.house(w.fee, 'withdraw_fee', `withdrawal:${id}`);
    });
    hub.toUser(w.user_id, { t: 'wallet', withdrawal: withdrawalRow(id) });
  }

  // Held withdrawals of an account that was cleared go out; for a suspended
  // account they are forfeited.
  function releaseHeld(userId) {
    for (const w of db.all("SELECT id FROM withdrawals WHERE user_id = ? AND status = 'review'", userId)) {
      db.run("UPDATE withdrawals SET status = 'processing' WHERE id = ?", w.id);
      scheduleWithdraw(w.id);
    }
  }
  function forfeitHeld(userId) {
    for (const w of db.all("SELECT * FROM withdrawals WHERE user_id = ? AND status IN ('review','processing')", userId)) {
      db.run("UPDATE withdrawals SET status = 'rejected', note = 'Account suspended', completed_at = ? WHERE id = ?", now(), w.id);
      money.house(w.amount, 'forfeit', `withdrawal:${w.id}`);
    }
  }

  const depositRow = (id) => db.get('SELECT id, coin, amount, coin_amount, confirmations, required, status, txid, created_at, credited_at FROM deposits WHERE id = ?', id);
  const withdrawalRow = (id) => db.get('SELECT id, coin, address, amount, fee, net, coin_amount, status, txid, created_at, completed_at FROM withdrawals WHERE id = ?', id);

  function overview(userId) {
    return {
      deposits: db.all('SELECT id, coin, amount, coin_amount, confirmations, required, status, txid, created_at FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 50', userId),
      withdrawals: db.all('SELECT id, coin, address, amount, fee, net, coin_amount, status, txid, created_at FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 50', userId),
      ledger: db.all('SELECT id, kind, amount, balance_after, ref, note, created_at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 100', userId),
    };
  }

  return { address, testDeposit, withdraw, overview, resumePending, releaseHeld, forfeitHeld, completeWithdraw };
}

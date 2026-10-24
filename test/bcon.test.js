// Real-payments mode against a stand-in for Bcon's API. The stand-in keeps
// the shapes from Bcon's docs (bcon.global/integrations/api).
import http from 'node:http';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, Client, checkBooks } from './helpers.js';

const SECRET = 'test-secret-0123456789abcdefghij';
const TRON_WALLET = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
const KEYS = new Set(['main-key', 'k-btc', 'k-tron']);

// ---- fake Bcon ----
const fake = {
  btcUsd: 100_000,
  next: 0,
  txs: new Map(),        // txid -> transaction
  quotes: new Set(),     // open tron amounts, to offset repeats like Bcon does
  calls: [],
};
function fakeTx(txid, address, sum, currencyId, status = 'confirmed') {
  fake.txs.set(txid, { id: fake.txs.size + 1, transaction_id: txid, address, status, sum, currency: { id: currencyId, name: currencyId === 1 ? 'BTC' : 'USDT', iso_name: currencyId === 1 ? 'btc' : 'usdt' }, created_at: new Date().toISOString() });
}
const fakeServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = String(req.headers.authorization || '').replace(/^Bearer /, '');
  let body = '';
  for await (const c of req) body += c;
  fake.calls.push({ method: req.method, path: url.pathname, key });
  const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
  if (!KEYS.has(key)) return send(401, { errorMessage: 'Store or user api key is undefined' });

  if (url.pathname === '/api/v1/stores/') {
    return send(200, { status: 'Ok', data: { addresses: [{
      id: 7, name: 'ChessBets', xpub: 'zpub6test', api_key: 'k-btc', callback_url: `https://cb.example/api/wallet/bcon/callback/${SECRET}`,
      chains: [
        { chain: 'bitcoin', code: 'btc', api_key: 'k-btc', callback_url: `https://cb.example/api/wallet/bcon/callback/${SECRET}`, address: null, xpub: 'zpub6test' },
        { chain: 'binance', code: 'bnb', api_key: 'k-bnb', callback_url: null, address: null },
        { chain: 'tron', code: 'trx', api_key: 'k-tron', callback_url: null, address: TRON_WALLET, xpub: null },
      ],
    }] } });
  }
  if (url.pathname === '/api/v2/address' && req.method === 'POST') {
    const b = JSON.parse(body);
    if (b.chain === 'bitcoin') {
      if (key !== 'k-btc') return send(400, { status: 'Wrong key for chain' });
      const address = `bc1qtest${String(++fake.next).padStart(30, '0')}`;
      return send(200, { status: 'Ok', data: { message: 'Address successfully created', address, payment_amount: (Number(b.origin_amount) / fake.btcUsd).toFixed(8), payment_currency: 'btc' } });
    }
    if (b.chain === 'tron') {
      if (key !== 'k-tron') return send(400, { status: 'Wrong key for chain' });
      let amt = Math.round(Number(b.origin_amount) * 100);
      while (fake.quotes.has(amt)) amt += 1;
      fake.quotes.add(amt);
      return send(200, { status: 'Ok', data: { message: 'Address successfully created', address: TRON_WALLET, payment_amount: (amt / 100).toFixed(2), payment_currency: 'usdt' } });
    }
    return send(200, { status: 'Chain not configured' });
  }
  const tx = /^\/api\/v1\/transactions\/(.+)$/.exec(url.pathname);
  if (tx) {
    const t = fake.txs.get(decodeURIComponent(tx[1]));
    return t ? send(200, { status: 'Ok', data: { transaction: t } }) : send(404, { status: 'Not found' });
  }
  if (url.pathname === '/api/v1/user/history') {
    const a = url.searchParams.get('address');
    const list = [...fake.txs.values()].filter((t) => t.address === a).reverse();
    return send(200, { status: 'Ok', data: { transactions: list.map((t) => ({ transaction_id: t.transaction_id, status: t.status, sum: t.sum, currency: t.currency, created_at: t.created_at })) } });
  }
  if (url.pathname === '/api/v1/currencies/btc') return send(200, { status: 'Ok', data: { price: String(fake.btcUsd) } });
  send(404, { status: 'Not found' });
});

let app;
let admin;
const hook = (q = '', secret = SECRET) => `/api/wallet/bcon/callback/${secret}${q}`;

before(async () => {
  await new Promise((r) => fakeServer.listen(0, '127.0.0.1', r));
  process.env.PAYMENTS = 'bcon';
  process.env.BCON_API_KEY = 'main-key';
  process.env.BCON_CALLBACK_SECRET = SECRET;
  process.env.BCON_API_URL = `http://127.0.0.1:${fakeServer.address().port}`;
  process.env.BCON_COINS = 'BTC,USDT-TRC20';
  process.env.BCON_POLL_MS = '3600000';
  process.env.ADMIN_USERS = 'boss';
  app = await boot();
  admin = new Client(app.base);
  await admin.register('boss');
});
after(async () => {
  await app?.close();
  fakeServer.close();
});

async function player(name) {
  const c = new Client(app.base);
  await c.register(name);
  return c;
}
const raw = (path, init) => fetch(app.base + path, init);

test('only coins the store has wallets for (and BCON_COINS allows) are offered', async () => {
  const cfg = (await admin.req('/api/config')).data;
  assert.equal(cfg.payments, 'bcon');
  assert.deepEqual(cfg.coins.map((c) => c.code), ['BTC', 'USDT-TRC20']);
  const usdt = cfg.coins.find((c) => c.code === 'USDT-TRC20');
  assert.equal(usdt.label, 'USDT');
  assert.equal(usdt.network, 'Tron (TRC-20)');
});

test('bitcoin deposit: seen, then confirmed, credited once', async () => {
  const p = await player('alice');
  const r = await p.req('/api/wallet/deposit', { coin: 'BTC', amount: 5000 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data.deposit;
  assert.match(d.address, /^bc1qtest/);
  assert.equal(d.coin_amount, '0.00050000');
  assert.match(d.qr, /<svg/);
  assert.equal(d.status, 'awaiting');
  // The bitcoin address was asked for with the bitcoin chain's own key.
  assert.equal(fake.calls.findLast((c) => c.path === '/api/v2/address').key, 'k-btc');

  // Asking again for the same coin and amount reuses the open deposit.
  const again = await p.req('/api/wallet/deposit', { coin: 'BTC', amount: 5000 });
  assert.equal(again.data.deposit.id, d.id);

  fakeTx('aa11bb22cc33dd44', d.address, '0.0005', 1, 'unconfirmed');
  let res = await raw(hook(`?status=0&addr=${d.address}&value=50000&txid=aa11bb22cc33dd44&external_id=cb-${d.id}`));
  assert.equal(res.status, 200);
  assert.equal((await p.req(`/api/wallet/deposits/${d.id}`)).data.deposit.status, 'confirming');
  assert.equal(await p.balance(), 0);

  fake.txs.get('aa11bb22cc33dd44').status = 'confirmed';
  // Bcon may POST a form instead of a GET with a query string.
  res = await raw(hook(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `status=2&addr=${d.address}&value=50000&txid=aa11bb22cc33dd44&external_id=cb-${d.id}` });
  assert.equal(res.status, 200);
  assert.equal(await p.balance(), 5000);

  // Repeats change nothing.
  await raw(hook(`?status=2&txid=aa11bb22cc33dd44&external_id=cb-${d.id}`));
  await raw(hook(`?status=2&txid=aa11bb22cc33dd44`));
  await app.ctx.wallet.sweep();
  assert.equal(await p.balance(), 5000);
  const dep = (await p.req(`/api/wallet/deposits/${d.id}`)).data.deposit;
  assert.equal(dep.status, 'credited');
  assert.equal(dep.credited, 5000);
  await checkBooks(app.ctx.db);
});

test('callbacks are not trusted: wrong secret, unknown tx, and lies about the address', async () => {
  const p = await player('mallory');
  const d = (await p.req('/api/wallet/deposit', { coin: 'BTC', amount: 10000 })).data.deposit;

  let res = await raw(hook(`?status=2&addr=${d.address}&txid=ff00ff00ff00ff00&external_id=cb-${d.id}`, 'wrong-secret-0123456789abcdefgh'));
  assert.equal(res.status, 404);

  // Right secret, but Bcon has never heard of this transaction.
  res = await raw(hook(`?status=2&addr=${d.address}&value=100000&txid=ff00ff00ff00ff00&external_id=cb-${d.id}`));
  assert.equal(res.status, 503);
  assert.equal(await p.balance(), 0);
  assert.equal((await app.ctx.db.payments.findOne({ _id: 'ff00ff00ff00ff00' })).status, 'pending');

  // A real transaction, but to some other address: the callback claims it
  // paid this deposit; Bcon's record says otherwise.
  fakeTx('ee00ee00ee00ee00', 'bc1qsomebodyelse000000000000000000000', '0.001', 1);
  res = await raw(hook(`?status=2&addr=${d.address}&value=100000&txid=ee00ee00ee00ee00&external_id=cb-${d.id}`));
  assert.equal(res.status, 200);
  assert.equal(await p.balance(), 0);
  assert.equal((await app.ctx.db.payments.findOne({ _id: 'ee00ee00ee00ee00' })).status, 'unmatched');

  // Malformed txids are ignored outright.
  res = await raw(hook('?status=2&txid=../../etc'));
  assert.equal(res.status, 200);
  assert.equal((await app.ctx.db.deposits.findOne({ _id: d.id })).status, 'awaiting');
});

test('tron: one shared wallet, deposits told apart by exact amount', async () => {
  const a = await player('tron_a');
  const b = await player('tron_b');
  const da = (await a.req('/api/wallet/deposit', { coin: 'USDT-TRC20', amount: 2500 })).data.deposit;
  const db = (await b.req('/api/wallet/deposit', { coin: 'USDT-TRC20', amount: 2500 })).data.deposit;
  assert.equal(da.address, TRON_WALLET);
  assert.equal(db.address, TRON_WALLET);
  assert.equal(da.coin_amount, '25.00');
  assert.equal(db.coin_amount, '25.01');
  assert.equal(fake.calls.findLast((c) => c.path === '/api/v2/address').key, 'k-tron');

  // b pays first; the callback carries no external_id.
  fakeTx('7r0n7x1d000000000000000000000001', TRON_WALLET, '25.01', 19);
  await raw(hook(`?status=2&addr=${TRON_WALLET}&value=25010000&txid=7r0n7x1d000000000000000000000001`));
  assert.equal(await b.balance(), 2500);
  assert.equal(await a.balance(), 0);

  // a's payment never gets a callback; the sweep finds it in the history.
  fakeTx('7r0n7x1d000000000000000000000002', TRON_WALLET, '25.000000', 19);
  await app.ctx.wallet.sweep();
  assert.equal(await a.balance(), 2500);
  assert.equal(await b.balance(), 2500);

  // A payment matching no open deposit is left for staff.
  fakeTx('7r0n7x1d000000000000000000000003', TRON_WALLET, '24.75', 19);
  await raw(hook(`?status=2&txid=7r0n7x1d000000000000000000000003`));
  assert.equal((await app.ctx.db.payments.findOne({ _id: '7r0n7x1d000000000000000000000003' })).status, 'unmatched');
  const view = (await admin.req('/api/admin/payments')).data;
  assert.ok(view.problems.some((x) => x.id === '7r0n7x1d000000000000000000000003'));
  assert.equal(view.store.connected, true);
  assert.equal(view.store.chains.find((c) => c.chain === 'bitcoin').callbackOk, true);
  assert.equal(view.store.chains.find((c) => c.chain === 'tron').callbackOk, false);
  await checkBooks(app.ctx.db);
});

test('short and late payments are valued fairly', async () => {
  const p = await player('carol');
  // 10% short, on time: pro rata at the quoted price.
  const d1 = (await p.req('/api/wallet/deposit', { coin: 'BTC', amount: 10000 })).data.deposit;
  fakeTx('5h0r7000000000000001', d1.address, '0.0009', 1);
  await raw(hook(`?status=2&txid=5h0r7000000000000001&external_id=cb-${d1.id}`));
  assert.equal(await p.balance(), 9000);

  // Paid after the quote expired, and bitcoin has halved since: the lower
  // current price applies.
  const d2 = (await p.req('/api/wallet/deposit', { coin: 'BTC', amount: 20000 })).data.deposit;
  await app.ctx.db.deposits.update({ _id: d2.id }, { $set: { expires_at: Date.now() - 1000 } });
  fake.btcUsd = 50_000;
  fakeTx('1a7e0000000000000001', d2.address, '0.002', 1);
  await raw(hook(`?status=2&txid=1a7e0000000000000001&external_id=cb-${d2.id}`));
  assert.equal(await p.balance(), 9000 + 10000);
  fake.btcUsd = 100_000;
  await app.ctx.wallet.bcon.rate('BTC', { fresh: true });
  await checkBooks(app.ctx.db);
});

test('money reaching a suspended account is held, not credited', async () => {
  const p = await player('dave');
  const d = (await p.req('/api/wallet/deposit', { coin: 'BTC', amount: 3000 })).data.deposit;
  await app.ctx.enforcement.suspend(p.user.id, 'test');
  fakeTx('d4e0000000000000000001', d.address, '0.0003', 1);
  await raw(hook(`?status=2&txid=d4e0000000000000000001&external_id=cb-${d.id}`));
  assert.equal(await p.balance(), 0);
  assert.equal((await app.ctx.db.payments.findOne({ _id: 'd4e0000000000000000001' })).status, 'held');
  assert.equal((await app.ctx.db.deposits.findOne({ _id: d.id })).status, 'held');
  await checkBooks(app.ctx.db);
});

test('withdrawals wait for staff: sent with a txid, or declined and refunded', async () => {
  const p = await player('erin');
  const d = (await p.req('/api/wallet/deposit', { coin: 'BTC', amount: 10000 })).data.deposit;
  fakeTx('e000000000000000000001', d.address, '0.001', 1);
  await raw(hook(`?status=2&txid=e000000000000000000001&external_id=cb-${d.id}`));
  assert.equal(await p.balance(), 10000);

  let r = await p.req('/api/wallet/withdraw', { coin: 'USDT-TRC20', address: '0x52908400098527886E0F7030069857D2E4169EE7', amount: 2000 });
  assert.equal(r.status, 400, 'an Ethereum address is refused for a Tron withdrawal');

  r = await p.req('/api/wallet/withdraw', { coin: 'USDT-TRC20', address: TRON_WALLET, amount: 2000 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const w1 = r.data.withdrawal;
  assert.equal(w1.coin_amount, '19.00');
  await new Promise((res) => setTimeout(res, 150));
  assert.equal((await app.ctx.db.withdrawals.findOne({ _id: w1.id })).status, 'processing', 'nothing is sent automatically');

  assert.equal((await p.req(`/api/admin/withdrawals/${w1.id}/sent`, { txid: 'abc' })).status, 404, 'players are not staff');
  assert.equal((await admin.req(`/api/admin/withdrawals/${w1.id}/sent`, {})).status, 400);
  assert.equal((await admin.req(`/api/admin/withdrawals/${w1.id}/sent`, { txid: 'f1f2f3f4f5f6f7f8f9' })).status, 200);
  assert.equal((await admin.req(`/api/admin/withdrawals/${w1.id}/sent`, { txid: 'f1f2f3f4f5f6f7f8f9' })).status, 409);
  const sent = await app.ctx.db.withdrawals.findOne({ _id: w1.id });
  assert.equal(sent.status, 'completed');
  assert.equal(sent.txid, 'f1f2f3f4f5f6f7f8f9');
  assert.equal(await p.balance(), 8000);

  const w2 = (await p.req('/api/wallet/withdraw', { coin: 'BTC', address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', amount: 3000 })).data.withdrawal;
  assert.equal(w2.coin_amount, '0.00028500');
  assert.equal(await p.balance(), 5000);
  assert.equal((await admin.req(`/api/admin/withdrawals/${w2.id}/reject`, { note: 'Address flagged' })).status, 200);
  assert.equal(await p.balance(), 8000, 'the full amount, fee included, comes back');
  const view = (await admin.req('/api/admin/payments')).data;
  assert.ok(!view.withdrawals.some((w) => w.id === w1.id || w.id === w2.id));
  await checkBooks(app.ctx.db);
});

test('staff can credit an unmatched payment by hand, once per txid', async () => {
  const p = await player('frank');
  const txid = '7r0n7x1d000000000000000000000003'; // the unmatched 24.75 USDT from the tron test
  let r = await admin.req(`/api/admin/users/${p.user.id}/credit`, { amount: 2475, txid, note: 'Short USDT payment' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(await p.balance(), 2475);
  r = await admin.req(`/api/admin/users/${p.user.id}/credit`, { amount: 2475, txid });
  assert.equal(r.status, 400);
  // A txid already credited automatically can't be credited again either.
  r = await admin.req(`/api/admin/users/${p.user.id}/credit`, { amount: 5000, txid: 'aa11bb22cc33dd44' });
  assert.equal(r.status, 400);
  assert.equal(await p.balance(), 2475);
  await checkBooks(app.ctx.db);
});

test('deposit limits', async () => {
  const p = await player('gina');
  assert.equal((await p.req('/api/wallet/deposit', { coin: 'BTC', amount: 500 })).status, 400);
  assert.equal((await p.req('/api/wallet/deposit', { coin: 'ETH', amount: 5000 })).status, 400);
  for (const amount of [1000, 1100, 1200]) assert.equal((await p.req('/api/wallet/deposit', { coin: 'BTC', amount })).status, 200);
  assert.equal((await p.req('/api/wallet/deposit', { coin: 'BTC', amount: 1300 })).status, 400, 'three open deposits at most');
  assert.equal((await p.req('/api/wallet/address', { coin: 'BTC' })).status, 400);
});

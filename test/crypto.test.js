// Real-payments mode against stand-ins for mempool.space (Esplora), a price
// feed and TronGrid. The response shapes match what those services return.
import http from 'node:http';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { boot, Client, checkBooks, testMongo, testDbName } from './helpers.js';

// BIP84 test vector (the "abandon ... about" mnemonic): account zpub and
// its first two receive addresses.
const ZPUB = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const ADDR0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const ADDR1 = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g';
const TRON = 'TQE21ewYVRY1wQGxgn7boLD3P3s236Q5ys';
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const chain = { tip: 900_000, btc: [], tron: [], usd: 80_000, hits: 0 };
let seq = 0;
const hex = () => (++seq).toString(16).padStart(64, 'a');
function btcTx(outputs, height = null) {
  const t = { txid: hex(), vout: outputs.map(([a, v]) => ({ scriptpubkey_address: a, value: v })), status: height ? { confirmed: true, block_height: height } : { confirmed: false } };
  chain.btc.unshift(t);
  return t;
}
function usdtTx(micro, { at = Date.now(), contract = USDT, to = TRON } = {}) {
  const t = { transaction_id: hex(), token_info: { symbol: 'USDT', address: contract, decimals: 6, name: 'Tether USD' }, block_timestamp: at, from: 'THp7AHx7UHkoJoWeUyGK7ixs1gWemA45xd', to, type: 'Transfer', value: String(micro) };
  chain.tron.unshift(t);
  return t;
}

const fake = http.createServer((req, res) => {
  chain.hits++;
  const u = new URL(req.url, 'http://x');
  const send = (j) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(typeof j === 'string' ? j : JSON.stringify(j)); };
  if (u.pathname === '/btc/blocks/tip/height') return send(String(chain.tip));
  const a = /^\/btc\/address\/([^/]+)\/txs$/.exec(u.pathname);
  if (a) return send(chain.btc.filter((t) => t.vout.some((o) => o.scriptpubkey_address === a[1])));
  if (u.pathname === '/price') return send({ time: 1, USD: chain.usd });
  const t = /^\/tron\/v1\/accounts\/([^/]+)\/transactions\/trc20$/.exec(u.pathname);
  if (t) {
    const min = Number(u.searchParams.get('min_timestamp') || 0);
    const contract = u.searchParams.get('contract_address');
    // The real API filters by contract too; this stand-in leaks fakes
    // through so the app's own check is tested.
    void contract;
    return send({ data: chain.tron.filter((x) => x.to === t[1] && x.block_timestamp >= min), success: true, meta: {} });
  }
  res.writeHead(404); res.end('{}');
});

let app;
let admin;

before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}`;
  Object.assign(process.env, {
    PAYMENTS: 'crypto', BTC_XPUB: ZPUB,
    BTC_API: `http://127.0.0.1:9/btc,${base}/btc`, // the first explorer is down
    BTC_PRICE_URLS: `${base}/price`, TRON_ADDRESS: TRON, TRON_API: `${base}/tron`,
    CRYPTO_POLL_MS: '3600000', ADMIN_USERS: 'boss',
  });
  app = await boot();
  admin = new Client(app.base);
  await admin.register('boss');
});
after(async () => {
  await app?.close();
  fake.close();
});

async function player(name) {
  const c = new Client(app.base);
  await c.register(name);
  return c;
}
const sweep = () => app.ctx.wallet.sweep();
const payment = (id) => app.ctx.db.payments.findOne({ _id: id });

test('bitcoin and USDT on Tron are offered', async () => {
  const cfg = (await admin.req('/api/config')).data;
  assert.equal(cfg.payments, 'crypto');
  assert.deepEqual(cfg.coins.map((c) => c.code), ['BTC', 'USDT-TRC20']);
});

test('each player gets the next address from the xpub, and keeps it', async () => {
  const a = await player('ann');
  const b = await player('ben');
  const ra = await a.req('/api/wallet/address', { coin: 'BTC' });
  assert.equal(ra.status, 200, JSON.stringify(ra.data));
  assert.equal(ra.data.address, ADDR0);
  assert.match(ra.data.qr, /<svg/);
  assert.equal((await b.req('/api/wallet/address', { coin: 'BTC' })).data.address, ADDR1);
  assert.equal((await a.req('/api/wallet/address', { coin: 'BTC' })).data.address, ADDR0, 'same address next time');
  assert.equal((await a.req('/api/wallet/address', { coin: 'USDT-TRC20' })).status, 400);
});

test('bitcoin: seen, confirmed, credited once at the current price', async () => {
  const ann = new Client(app.base);
  await ann.req('/api/login', { username: 'ann', password: 'password123' });
  const t = btcTx([[ADDR0, 50_000], ['bc1qsomeoneschange000000000000000000000', 9_000]]);

  const r = await ann.req('/api/wallet/refresh', {});
  assert.equal(r.status, 200);
  let dep = r.data.deposits[0];
  assert.equal(dep.status, 'confirming');
  assert.equal(dep.confirmations, 0);
  assert.equal(dep.coin_amount, '0.00050000');
  assert.equal(await ann.balance(), 0);

  t.status = { confirmed: true, block_height: chain.tip };
  await sweep();
  dep = (await ann.req('/api/wallet')).data.deposits[0];
  assert.equal(dep.confirmations, 1);
  assert.equal(await ann.balance(), 0);

  chain.tip += 1;
  await sweep();
  // 0.0005 BTC at $80,000 = $40.00
  assert.equal(await ann.balance(), 4000);
  dep = (await ann.req('/api/wallet')).data.deposits[0];
  assert.equal(dep.status, 'credited');
  assert.equal(dep.credited, 4000);

  await sweep();
  await sweep();
  assert.equal(await ann.balance(), 4000, 'credited once');
  assert.equal((await ann.req('/api/wallet')).data.deposits.length, 1);
  await checkBooks(app.ctx.db);
});

test('one transaction paying two players credits both', async () => {
  const c = await player('cat');
  const d = await player('dan');
  const ac = (await c.req('/api/wallet/address', { coin: 'BTC' })).data.address;
  const ad = (await d.req('/api/wallet/address', { coin: 'BTC' })).data.address;
  btcTx([[ac, 100_000], [ad, 25_000]], chain.tip - 5);
  await sweep();
  assert.equal(await c.balance(), 8000);
  assert.equal(await d.balance(), 2000);
  await checkBooks(app.ctx.db);
});

test('dust and money sent to a suspended account are held for staff', async () => {
  const e = await player('eve');
  const ae = (await e.req('/api/wallet/address', { coin: 'BTC' })).data.address;
  const small = btcTx([[ae, 1_000]], chain.tip - 3); // $0.80
  await sweep();
  assert.equal(await e.balance(), 0);
  assert.equal((await payment(`btc:${small.txid}:${ae}`)).status, 'held');

  const f = await player('fay');
  const af = (await f.req('/api/wallet/address', { coin: 'BTC' })).data.address;
  await app.ctx.enforcement.suspend(f.user.id, 'test');
  const big = btcTx([[af, 200_000]], chain.tip - 3);
  await sweep();
  assert.equal(await f.balance(), 0);
  assert.equal((await payment(`btc:${big.txid}:${af}`)).status, 'held');

  const view = (await admin.req('/api/admin/payments')).data;
  assert.ok(view.problems.some((p) => p.txid === small.txid));
  assert.ok(view.problems.some((p) => p.txid === big.txid));
  assert.equal(view.wallets.btc.firstAddress, ADDR0);
  assert.ok(view.wallets.lastScan);
  await checkBooks(app.ctx.db);
});

test('USDT on Tron: one wallet, deposits told apart by exact amount', async () => {
  const g = await player('gus');
  const h = await player('hal');
  // A transfer from before anyone asked must not count for them.
  usdtTx(25_000_000, { at: Date.now() - 30 * 60_000 });
  const dg = (await g.req('/api/wallet/deposit', { coin: 'USDT-TRC20', amount: 2500 })).data.deposit;
  const dh = (await h.req('/api/wallet/deposit', { coin: 'USDT-TRC20', amount: 2500 })).data.deposit;
  assert.equal(dg.address, TRON);
  assert.equal(dg.coin_amount, '25.00');
  assert.equal(dh.coin_amount, '25.01');
  assert.equal((await g.req('/api/wallet/deposit', { coin: 'USDT-TRC20', amount: 2500 })).data.deposit.id, dg.id, 'same request reused');

  usdtTx(25_010_000, { contract: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf' }); // a fake "USDT"
  await sweep();
  assert.equal(await h.balance(), 0, 'fake tokens are ignored');

  usdtTx(25_010_000);
  await sweep();
  assert.equal(await h.balance(), 2500);
  assert.equal(await g.balance(), 0);

  usdtTx(25_000_000);
  usdtTx(500_000); // dust, ignored
  usdtTx(24_750_000); // an exchange took its fee out: no match
  await sweep();
  assert.equal(await g.balance(), 2500);
  const view = (await admin.req('/api/admin/payments')).data;
  const usdtProblems = view.problems.filter((p) => p.coin === 'USDT-TRC20');
  assert.deepEqual(usdtProblems.map((p) => p.sum), ['24.75'], 'the short payment waits for staff');
  const early = chain.tron.at(-1);
  assert.equal(await payment(`trx:${early.transaction_id}`), null, 'a transfer from before any request is none of our business');
  assert.equal((await g.req(`/api/wallet/deposits/${dg.id}`)).data.deposit.status, 'credited');
  await checkBooks(app.ctx.db);
});

test('USDT: a paid amount is not handed out again, so a repeat payment cannot land on someone else', async () => {
  const j = await player('joe');
  const k = await player('kim');
  const dj = (await j.req('/api/wallet/deposit', { coin: 'USDT-TRC20', amount: 4000 })).data.deposit;
  assert.equal(dj.coin_amount, '40.00');
  usdtTx(40_000_000);
  await sweep();
  assert.equal(await j.balance(), 4000);

  // Kim asks for the same dollar amount after Jo's request was paid.
  const dk = (await k.req('/api/wallet/deposit', { coin: 'USDT-TRC20', amount: 4000 })).data.deposit;
  assert.notEqual(dk.coin_amount, '40.00');
  // Jo pays 40.00 again: it must not count for Kim.
  const again = usdtTx(40_000_000);
  await sweep();
  assert.equal(await k.balance(), 0);
  assert.equal(await j.balance(), 4000, 'not credited twice either');
  assert.equal((await payment(`trx:${again.transaction_id}`)).status, 'unmatched', 'the repeat waits for staff');
  await checkBooks(app.ctx.db);
});

test('staff credit an unmatched payment by hand, once', async () => {
  const i = await player('ivy');
  const short = chain.tron.find((t) => t.value === '24750000');
  let r = await admin.req(`/api/admin/users/${i.user.id}/credit`, { amount: 2475, txid: short.transaction_id, coin: 'USDT-TRC20', note: 'Short USDT payment' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(await i.balance(), 2475);
  assert.equal((await payment(`trx:${short.transaction_id}`)).status, 'resolved');
  r = await admin.req(`/api/admin/users/${i.user.id}/credit`, { amount: 2475, txid: short.transaction_id });
  assert.equal(r.status, 400);
  const ann = chain.btc.find((t) => t.vout[0].scriptpubkey_address === ADDR0);
  r = await admin.req(`/api/admin/users/${i.user.id}/credit`, { amount: 100, txid: ann.txid });
  assert.equal(r.status, 400, 'a txid credited automatically cannot be credited again');
  await checkBooks(app.ctx.db);
});

test('withdrawals: checksummed addresses, then sent or declined by staff', async () => {
  const ann = new Client(app.base);
  await ann.req('/api/login', { username: 'ann', password: 'password123' });
  const bad = [
    ['BTC', 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyv'], // one character off
    ['BTC', 'tb1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'], // testnet
    ['USDT-TRC20', 'TQE21ewYVRY1wQGxgn7boLD3P3s236Q5yt'],
    ['USDT-TRC20', ADDR1],
  ];
  for (const [coin, address] of bad) assert.equal((await ann.req('/api/wallet/withdraw', { coin, address, amount: 1000 })).status, 400, address);

  const w1 = (await ann.req('/api/wallet/withdraw', { coin: 'BTC', address: '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA', amount: 2000 })).data.withdrawal;
  assert.equal(w1.coin_amount, '0.00023750'); // $19 at $80,000
  const w2 = (await ann.req('/api/wallet/withdraw', { coin: 'USDT-TRC20', address: TRON, amount: 1000 })).data.withdrawal;
  assert.equal(w2.coin_amount, '9.50');
  assert.equal(await ann.balance(), 1000);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await app.ctx.db.withdrawals.findOne({ _id: w1.id })).status, 'processing', 'nothing is sent automatically');

  assert.equal((await admin.req(`/api/admin/withdrawals/${w1.id}/sent`, { txid: 'f1f2f3f4f5f6f7f8f9' })).status, 200);
  assert.equal((await admin.req(`/api/admin/withdrawals/${w2.id}/reject`, { note: 'Address flagged' })).status, 200);
  assert.equal(await ann.balance(), 2000);
  await checkBooks(app.ctx.db);
});

test('suspension with withdrawals waiting: staff mark sent what went out and forfeit the rest', async () => {
  const lee = await player('lee');
  assert.equal((await admin.req(`/api/admin/users/${lee.user.id}/credit`, { amount: 5000, txid: 'leedeposit0001', coin: 'USDT-TRC20' })).status, 200);
  const w1 = (await lee.req('/api/wallet/withdraw', { coin: 'USDT-TRC20', address: TRON, amount: 2000 })).data.withdrawal;
  const w2 = (await lee.req('/api/wallet/withdraw', { coin: 'USDT-TRC20', address: TRON, amount: 1000 })).data.withdrawal;
  assert.equal(await lee.balance(), 2000);

  await app.ctx.enforcement.suspend(lee.user.id, 'test');
  // The coins may already be on their way, so nothing is forfeited yet.
  assert.equal((await app.ctx.db.withdrawals.findOne({ _id: w1.id })).status, 'processing');
  assert.equal((await app.ctx.db.users.findOne({ _id: lee.user.id })).forfeited, 2000);
  const view = (await admin.req('/api/admin/payments')).data;
  assert.equal(view.withdrawals.find((w) => w.id === w1.id).user_status, 'suspended');

  // Staff had sent w1 already: recording it must still work.
  assert.equal((await admin.req(`/api/admin/withdrawals/${w1.id}/sent`, { txid: 'leesent00000001' })).status, 200);
  assert.equal((await app.ctx.db.withdrawals.findOne({ _id: w1.id })).status, 'completed');
  // w2 was never sent: declining it forfeits it, it doesn't land in the suspended balance.
  assert.equal((await admin.req(`/api/admin/withdrawals/${w2.id}/reject`, {})).status, 200);
  const u = await app.ctx.db.users.findOne({ _id: lee.user.id });
  assert.equal(u.balance, 0);
  assert.equal(u.forfeited, 3000);
  assert.ok(await app.ctx.db.ledger.findOne({ user_id: null, kind: 'forfeit', ref: `withdrawal:${w2.id}`, amount: 1000 }));
  await checkBooks(app.ctx.db);
});

test('bitcoin: a payment that vanishes before confirming is marked dropped, and revives if it comes back', async () => {
  const mo = await player('moe');
  const addr = (await mo.req('/api/wallet/address', { coin: 'BTC' })).data.address;
  const t = btcTx([[addr, 20_000]]);
  await sweep();
  let dep = (await mo.req('/api/wallet')).data.deposits[0];
  assert.equal(dep.status, 'confirming');

  chain.btc.splice(chain.btc.indexOf(t), 1); // replaced by a double spend
  await sweep();
  assert.equal((await app.ctx.db.deposits.findOne({ _id: dep.id })).status, 'confirming', 'one missed look is not enough');
  await app.ctx.db.deposits.update({ _id: dep.id }, { $set: { missing_since: Date.now() - 31 * 60_000 } });
  await sweep();
  dep = (await mo.req('/api/wallet')).data.deposits[0];
  assert.equal(dep.status, 'dropped');
  assert.equal((await payment(`btc:${t.txid}:${addr}`)).status, 'dropped');

  chain.btc.unshift(t); // rebroadcast after all
  await sweep();
  assert.equal((await app.ctx.db.deposits.findOne({ _id: dep.id })).status, 'confirming');
  t.status = { confirmed: true, block_height: chain.tip - 1 };
  await sweep();
  assert.equal(await mo.balance(), Math.floor((20_000 * chain.usd) / 1e6));
  await checkBooks(app.ctx.db);
});

test('a paper-money database is never opened for real money', async () => {
  const uri = await testMongo();
  const name = testDbName('paperdb');
  const c = new MongoClient(uri);
  await c.connect();
  await c.db(name).collection('counters').insertOne({ _id: 'payments_mode', mode: 'paper' });
  await assert.rejects(boot({ dbName: name }), /paper-money accounts/);
  await c.db(name).dropDatabase();
  await c.close();
});

// Browser checks with the system Chrome: `npm run test:e2e`
// Boots its own server on a free port with a throwaway database.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { testMongo, testDbName } from '../test/mongo.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-e2e-'));
const port = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const base = `http://127.0.0.1:${port}`;

const mongoUri = await testMongo();
const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', MONGODB_URI: mongoUri, MONGODB_DB: testDbName('e2e'), ADMIN_USERS: 'e2eadmin', PAYMENTS: 'paper',
    DEPOSIT_CONFIRM_MS: '150', WITHDRAW_PROCESS_MS: '200', BOT_MOVE_SCALE: '0.2', REGISTER_PER_HOUR: '1000', ANALYSIS_NODES: '50000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes('running at') && resolve());
  server.stderr.on('data', (d) => process.stderr.write(d));
  server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
});

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
let passed = 0, failed = 0;

async function newUser(name, { fund = 0, viewport = { width: 1366, height: 860 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  await page.goto(base + '/');
  await page.click('#regBtn');
  await page.fill('#au', name);
  await page.fill('#ap', 'password123');
  await page.check('input[name=adult]');
  await page.check('input[name=terms]');
  await page.click('button[type=submit]');
  await page.waitForSelector('#balAmt');
  if (fund) {
    await page.click('#walletBtn');
    await page.fill('#dep-amt', (fund / 100).toFixed(2));
    await page.click('#dep-go');
    await page.waitForFunction((f) => document.querySelector('#balAmt')?.textContent.replace(/[$,]/g, '') === (f / 100).toFixed(2), fund, { timeout: 8000 });
    await page.keyboard.press('Escape');
  }
  return page;
}

async function square(page, sq) {
  const b = await page.locator('#bd').boundingBox();
  const flipped = await page.evaluate(() => {
    const first = document.querySelector('#bd .coord.rank');
    return first?.textContent === '1';
  });
  const f = sq.charCodeAt(0) - 97, r = +sq[1] - 1;
  const x = flipped ? 7 - f : f, y = flipped ? r : 7 - r;
  return { x: b.x + ((x + 0.5) * b.width) / 8, y: b.y + ((y + 0.5) * b.height) / 8 };
}
async function move(page, from, to, drag = false) {
  const a = await square(page, from), b = await square(page, to);
  if (drag) {
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
  } else {
    await page.mouse.click(a.x, a.y); await page.mouse.click(b.x, b.y);
  }
}

async function check(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`);
    if (process.env.E2E_SHOTS) for (const [i, p] of browser.contexts().flatMap((c) => c.pages()).entries()) await p.screenshot({ path: `${process.env.E2E_SHOTS}/fail-${i}.png` }).catch(() => {});
  }
}

const money = (p) => p.locator('#balAmt').textContent();

await check('lobby renders queues, bots and footer for guests', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`guest: ${e.message}`));
  await page.goto(base + '/');
  await page.waitForSelector('.qtile');
  assert.equal(await page.locator('.qtile').count(), 6);
  assert.equal(await page.locator('.bot-card').count(), 3);
  assert.match(await page.locator('.footer').textContent(), /paper money/i);
  await page.click('.qtile >> nth=0');
  await page.waitForURL(/\/play/);
  await page.click('[data-act=login]');
  await page.waitForSelector('.modal');
  await ctx.close();
});

const alice = await newUser('alice_e2e', { fund: 20_000 });

await check('bot game: drag a move, the bot replies, resign settles', async () => {
  await alice.goto(base + '/bots/magnus');
  await alice.click('[data-color=w]');
  await alice.fill('#bamt', '7.00');
  await alice.click('[data-act=play]');
  await alice.waitForURL(/\/game\//);
  await alice.waitForSelector('#moves');
  await move(alice, 'e2', 'e4', true);
  await alice.waitForFunction(() => document.querySelectorAll('#moves button').length >= 2, null, { timeout: 15_000 });
  await move(alice, 'g1', 'f3');
  await alice.waitForFunction(() => document.querySelectorAll('#moves button').length >= 4, null, { timeout: 15_000 });
  assert.equal(await money(alice), '$193.00');
  assert.equal(await alice.locator('[data-a=draw]').count(), 0, 'no draw button against a bot');
  assert.equal(await alice.locator('.chat').count(), 0, 'no chat against a bot');
  await alice.click('[data-a=resign]');
  await alice.click('[data-yes]');
  await alice.waitForSelector('.result');
  assert.match(await alice.locator('.result h3').textContent(), /You lost/);
  assert.equal(await money(alice), '$193.00');
});

const bob = await newUser('bob_e2e', { fund: 5_000 });

await check('human game: queue, match, moves, chat, draw offer, rake on the draw', async () => {
  await alice.goto(base + '/play?tc=10&stake=500&go=1');
  await alice.waitForSelector('.search-card');
  await bob.goto(base + '/play?tc=10&stake=500&go=1');
  await alice.waitForURL(/\/game\//, { timeout: 10_000 });
  await bob.waitForURL(/\/game\//, { timeout: 10_000 });
  await alice.waitForSelector('#status');
  await bob.waitForSelector('#status');
  await alice.waitForTimeout(300);
  const aliceWhite = await alice.evaluate(() => document.querySelector('#bd .coord.rank')?.textContent === '8');
  const [W, B] = aliceWhite ? [alice, bob] : [bob, alice];
  await move(W, 'd2', 'd4');
  await B.waitForFunction(() => document.querySelectorAll('#moves button').length === 1);
  // A half-typed message must survive the opponent's move.
  await W.fill('.chat-form input', 'gl hf');
  await move(B, 'd7', 'd5', true);
  await W.waitForFunction(() => document.querySelectorAll('#moves button').length === 2);
  assert.equal(await W.inputValue('.chat-form input'), 'gl hf');
  await W.press('.chat-form input', 'Enter');
  await B.waitForSelector('.cm.opp');
  assert.match(await B.locator('.cm.opp').textContent(), /Opponent\s*gl hf/);
  await W.waitForSelector('.cm.me');
  assert.match(await W.locator('.cm.me').textContent(), /You\s*gl hf/);
  const [meBg, oppBg] = [await W.locator('.cm.me').evaluate((e) => getComputedStyle(e).backgroundColor), await B.locator('.cm.opp').evaluate((e) => getComputedStyle(e).backgroundColor)];
  assert.notEqual(meBg, oppBg);
  await B.click('[data-chat="0"]');
  await W.waitForFunction(() => [...document.querySelectorAll('.cm.opp')].some((e) => e.textContent.includes('Good luck')));
  if (process.env.E2E_SHOTS) { await W.screenshot({ path: `${process.env.E2E_SHOTS}/chat-w.png` }); await B.screenshot({ path: `${process.env.E2E_SHOTS}/chat-b.png` }); }
  await W.click('[data-a=draw]');
  await B.waitForSelector('[data-a=accept]');
  await B.click('[data-a=accept]');
  await W.waitForSelector('.result');
  assert.match(await W.locator('.result h3').textContent(), /Draw/);
  assert.match(await W.locator('.result .amount').textContent(), /\$4\.85/);
  await alice.waitForFunction(() => document.querySelector('#balAmt').textContent === '$192.85');
  await bob.waitForFunction(() => document.querySelector('#balAmt').textContent === '$49.85');
});

await check('withdrawal shows the 5% fee and completes', async () => {
  await bob.goto(base + '/');
  await bob.click('#walletBtn');
  await bob.click('[data-tab=withdraw]');
  await bob.click('[data-wcoin=ETH]');
  await bob.fill('#wd-addr', '0x' + 'ab'.repeat(20));
  await bob.fill('#wd-amt', '20');
  assert.match(await bob.locator('#wd-sum').textContent(), /-\$1\.00.*\$19\.00/s);
  await bob.click('#wd-go');
  await bob.waitForFunction(() => document.querySelector('#balAmt').textContent === '$29.85');
  await bob.waitForSelector('#wl-wds .status.ok', { timeout: 5000 });
  await bob.keyboard.press('Escape');
});

await check('suspension: banner, no refund message, play blocked, support reachable', async () => {
  const admin = await newUser('e2eadmin');
  await admin.goto(base + '/admin');
  await admin.fill('#q', 'bob_e2e');
  await admin.click('#qs');
  await admin.click('#qr a');
  await admin.waitForURL(/\/admin\/\d+/);
  await admin.click('[data-act=suspend]');
  await admin.click('[data-yes]');
  await bob.waitForSelector('.susp', { timeout: 5000 });
  assert.match(await bob.locator('.susp').textContent(), /will not be refunded/);
  assert.equal(await money(bob), '$0.00');
  await bob.goto(base + '/play');
  assert.equal(await bob.locator('.panel .btn-lg').textContent(), 'Account suspended');
  await bob.click('.susp a');
  await bob.waitForURL(/\/support/);
  await bob.fill('#tb', 'I think this suspension is a mistake, please review my games.');
  await bob.click('#tf button[type=submit]');
  await bob.waitForSelector('.ticket');
});

await check('mobile: no horizontal scroll, board fits, bottom nav present', async () => {
  const m = await newUser('mobile_e2e', { viewport: { width: 390, height: 844 } });
  for (const p of ['/', '/play', '/bots', '/fair-play', '/terms']) {
    await m.goto(base + p);
    await m.waitForTimeout(250);
    const over = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `${p} overflows by ${over}px`);
  }
  await m.goto(base + '/play');
  const b = await m.locator('.board').boundingBox();
  assert.ok(b.width <= 390 && b.width > 300);
  assert.ok(await m.locator('#mnav').isVisible());
});

await browser.close();
server.kill();
fs.rmSync(dir, { recursive: true, force: true });
if (errors.length) { console.log('\nBrowser errors:\n' + errors.join('\n')); failed++; }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// Screenshots of the sign-in, register and legal pages: `node test-e2e/shots.js <dir>`
import { spawn } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { testMongo, testDbName } from '../test/mongo.js';

const out = process.argv[2] || '.';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const port = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', MONGODB_URI: await testMongo(), MONGODB_DB: testDbName('shots'), PAYMENTS: 'paper' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((r) => server.stdout.on('data', (d) => String(d).includes('running at') && r()));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const [tag, viewport] of [['desk', { width: 1366, height: 860 }], ['phone', { width: 390, height: 844 }]]) {
    const page = await (await browser.newContext({ viewport, deviceScaleFactor: 2 })).newPage();
    await page.goto(base + '/');
    await page.click(tag === 'desk' ? '#loginBtn' : '#regBtn');
    await page.waitForSelector('.auth-form');
    await page.waitForTimeout(400);
    await page.fill('#au', 'sergei');
    await page.fill('#ap', 'hunter2hunter2');
    await page.screenshot({ path: `${out}/${tag}-auth.png` });
    await page.click('.pw-toggle');
    await page.screenshot({ path: `${out}/${tag}-auth-shown.png` });
    if (tag === 'desk') {
      await page.click('[data-swap]');
      await page.waitForSelector('input[name=terms]');
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${out}/desk-register.png` });
      await page.keyboard.press('Escape');
      for (const p of ['terms', 'privacy', 'fair-play']) {
        await page.goto(`${base}/${p}`);
        await page.waitForSelector('.prose h1');
        await page.screenshot({ path: `${out}/desk-${p}.png`, fullPage: true });
      }
    }
  }
} finally {
  await browser.close();
  server.kill();
}
process.exit(0);

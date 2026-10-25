import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, EnginePool } from '../src/engine.js';
import { config } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('a missing engine binary fails searches at once instead of hanging', async () => {
  const pool = new EnginePool(1, '/nonexistent/stockfish', {});
  const t = Date.now();
  await assert.rejects(pool.search({ moves: [], movetime: 200 }));
  assert.ok(Date.now() - t < 2000, 'rejected quickly');
  assert.equal(pool.healthy, false);
  assert.equal(await pool.whenReady(300), false);
  pool.quit();
});

test('a stuck engine is stopped, killed and restarted; the search fails', async () => {
  // Wrapper so the fixture runs as an executable on any machine.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-engine-'));
  const bin = path.join(dir, 'stuck');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, 'fixtures/stuck-engine.js')}"\n`, { mode: 0o755 });
  const e = new Engine(bin);
  try {
    await e.ready;
    assert.equal(e.ok, true);
    const t = Date.now();
    await assert.rejects(e.search({ moves: [], movetime: 100 }));
    const took = Date.now() - t;
    assert.ok(took >= 3000 && took < 9000, `gave up after ${took}ms`);
    await new Promise((r) => setTimeout(r, 600));
    await e.ready;
    assert.equal(e.ok, true, 'came back up');
  } finally {
    e.quit();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stopDepth ends a long timed search early', async () => {
  const e = new Engine(config.stockfishPath, { Threads: 1, Hash: 16 });
  try {
    const t = Date.now();
    const r = await e.search({ moves: ['e2e4', 'e7e5'], movetime: 20_000, stopDepth: 10 });
    assert.match(r.best, /^[a-h][1-8][a-h][1-8]/);
    assert.ok(r.lines[0].depth >= 10);
    assert.ok(Date.now() - t < 10_000, 'stopped well before the 20s budget');
  } finally { e.quit(); }
});

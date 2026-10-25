// Runs after `npm install`. Hosts like Render's native Node runtime have no
// Stockfish, and without it the bots never move. If no working engine is
// found, download the official Stockfish 19 Linux build into bin/stockfish.
//
// Skipped when STOCKFISH_PATH is set, when `stockfish` on the PATH works, or
// when bin/stockfish is already there and works. SKIP_STOCKFISH=1 skips it
// entirely (the server then refuses bot games).
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'bin', 'stockfish');

const BUILDS = {
  'linux-x64': {
    url: 'https://github.com/official-stockfish/Stockfish/releases/download/sf_19/stockfish-linux-x86-64-universal.tar.gz',
    sha256: '9defc0d4e55d49c65a6d042f3e571a39fcea499ade6dbe741b53b8c65e03611f',
    member: 'stockfish/stockfish-linux-x86-64-universal',
  },
};

const works = (bin) => {
  const r = spawnSync(bin, [], { input: 'uci\nquit\n', encoding: 'utf8', timeout: 20_000 });
  return !r.error && /uciok/.test(r.stdout || '');
};

async function main() {
  if (process.env.SKIP_STOCKFISH === '1') return console.log('stockfish: skipped (SKIP_STOCKFISH=1)');
  if (process.env.STOCKFISH_PATH) return console.log(`stockfish: using STOCKFISH_PATH=${process.env.STOCKFISH_PATH}`);
  if (works(DEST)) return console.log('stockfish: bin/stockfish is ready');
  if (works('stockfish')) return console.log('stockfish: found on the PATH');

  const build = BUILDS[`${os.platform()}-${os.arch()}`];
  if (!build) {
    console.warn(`stockfish: no download for ${os.platform()}-${os.arch()}. Install Stockfish and put it on the PATH, or set STOCKFISH_PATH.`);
    return;
  }

  console.log(`stockfish: downloading ${build.url}`);
  const res = await fetch(build.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sum = createHash('sha256').update(buf).digest('hex');
  if (sum !== build.sha256) throw new Error(`checksum mismatch: got ${sum}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stockfish-'));
  try {
    const tgz = path.join(tmp, 'sf.tar.gz');
    fs.writeFileSync(tgz, buf);
    execFileSync('tar', ['-xzf', tgz, '-C', tmp, build.member]);
    fs.mkdirSync(path.dirname(DEST), { recursive: true });
    fs.copyFileSync(path.join(tmp, build.member), DEST);
    fs.chmodSync(DEST, 0o755);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (!works(DEST)) throw new Error('downloaded binary does not answer "uci"');
  console.log('stockfish: installed bin/stockfish (Stockfish 19)');
}

main().catch((err) => {
  console.error(`stockfish: ${err.message}`);
  // Fail the install so a deploy without an engine never goes live.
  process.exit(1);
});

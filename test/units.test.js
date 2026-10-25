import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanPayouts, rakeOf, withdrawFeeOf, fmt } from '../src/money.js';
import { binomTail, fisherCombine, winPct, moveAccuracy, scorePlayer, accountEvidence, decide, MODEL } from '../src/anticheat.js';
import { cleanChat } from '../src/hub.js';
import { COINS, toCoin } from '../src/wallet.js';
import { parseInfo, scoreCp } from '../src/engine.js';

test('human payouts: 3% rake on the pot, exact cents for every queue', () => {
  assert.deepEqual(humanPayouts(100), { pot: 200, rake: 6, win: 194, draw: 97 });
  assert.deepEqual(humanPayouts(500), { pot: 1000, rake: 30, win: 970, draw: 485 });
  assert.deepEqual(humanPayouts(1000), { pot: 2000, rake: 60, win: 1940, draw: 970 });
  for (const s of [100, 500, 1000]) {
    const p = humanPayouts(s);
    assert.equal(p.win + p.rake, p.pot);
    assert.equal(p.draw * 2 + rakeOf(s) * 2, p.pot);
  }
});

test('withdrawal fee is 5%', () => {
  assert.equal(withdrawFeeOf(10_000), 500);
  assert.equal(withdrawFeeOf(500), 25);
  assert.equal(withdrawFeeOf(1234), 62);
});

test('money formatting', () => {
  assert.equal(fmt(123456), '$1,234.56');
  assert.equal(fmt(-5), '-$0.05');
});

test('binomial tail', () => {
  assert.equal(binomTail(0, 10, 0.5), 1);
  assert.ok(Math.abs(binomTail(10, 10, 0.5) - 1 / 1024) < 1e-12);
  assert.ok(Math.abs(binomTail(9, 10, 0.5) - 11 / 1024) < 1e-12);
  assert.equal(binomTail(11, 10, 0.5), 0);
});

test('fisher combination is exact and monotone', () => {
  assert.equal(fisherCombine([]), 1);
  assert.ok(Math.abs(fisherCombine([0.05]) - 0.05) < 1e-12);
  // Two p-values of 0.05: X = -2 ln(0.0025) ~ 11.98 on 4 df -> 0.0175
  assert.ok(Math.abs(fisherCombine([0.05, 0.05]) - 0.017479) < 1e-5);
  assert.ok(fisherCombine([0.01, 0.01, 0.01]) < fisherCombine([0.01, 0.01]));
  assert.equal(fisherCombine([1, 1, 1]), 1);
});

test('win% and accuracy curves', () => {
  assert.equal(winPct(0), 50);
  assert.ok(winPct(300) > 75 && winPct(-300) < 25);
  assert.ok(moveAccuracy(50, 50) > 99);
  assert.ok(moveAccuracy(70, 20) < 15);
});

function rows({ n, nearRate, crit = 0, critFound = 0, times = null, blur = 0, color = 'w' }) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const near = i < Math.round(n * nearRate);
    const isCrit = i < crit;
    out.push({
      ply: 10 + i * 2, color, played: 'a', best: near ? 'a' : 'b', bestCp: 20, playedCp: near ? 20 : -40,
      cpl: near ? 0 : 60, gap: isCrit ? 150 : 20, top1: near, near, nonTrivial: true, critical: isCrit,
      book: false, forced: false, decided: false, obvious: false, found: isCrit && i < critFound,
      acc: near ? 100 : 60, t: times ? times[i % times.length] : 3000, blur: i < blur,
    });
  }
  return out;
}

test('fair play: a strong human game is clean', () => {
  // 70% engine-level moves, finds half the hard ones, varied timing, no tab switching.
  const r = scorePlayer(rows({ n: 30, nearRate: 0.7, crit: 6, critFound: 3, times: [800, 4000, 12000, 2500, 30000, 1500] }), 'w');
  assert.equal(r.verdict, 'clean');
  assert.ok(r.evidence < 1.5, `evidence ${r.evidence}`);
  assert.equal(decide(r, accountEvidence([r])), 'none');
});

test('fair play: a perfect game alone does not suspend', () => {
  const r = scorePlayer(rows({ n: 30, nearRate: 1, crit: 6, critFound: 6, times: [800, 4000, 12000, 2500, 30000, 1500] }), 'w');
  assert.ok(r.verdict === 'suspicious' || r.verdict === 'clean');
  assert.notEqual(decide(r, accountEvidence([r])), 'suspend');
});

test('fair play: engine play with even timing and tab switching across games suspends', () => {
  const game = () => scorePlayer(rows({ n: 32, nearRate: 1, crit: 7, critFound: 7, times: [4100, 4600, 3900, 4400], blur: 25 }), 'w');
  const g1 = game();
  assert.equal(g1.verdict, 'engine-like');
  assert.ok(g1.corroboration >= 2);
  const g2 = game();
  const acct = accountEvidence([g1, g2]);
  assert.ok(acct.evidence >= MODEL.accountSuspendAt, `account ${acct.evidence}`);
  assert.equal(decide(g2, acct), 'suspend');
});

test('fair play: timing and focus never count without unusual moves', () => {
  const r = scorePlayer(rows({ n: 30, nearRate: 0.7, crit: 5, critFound: 2, times: [4000, 4100], blur: 30 }), 'w');
  assert.ok(r.corroboration > 0);           // measured...
  assert.equal(r.evidence, r.precision);    // ...but not counted
  assert.equal(r.verdict, 'clean');
  const acct = accountEvidence([r, r, r, r, r]);
  assert.equal(acct.evidence, acct.precision);
  assert.equal(decide(r, acct), 'none');
});

test('fair play: too few positions is insufficient', () => {
  const r = scorePlayer(rows({ n: 6, nearRate: 1 }), 'w');
  assert.equal(r.verdict, 'insufficient');
});

test('fair play: many honest strong games never cross the account line', () => {
  // A player at 72% (just under the 75% baseline) over 20 games.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const reports = [];
  for (let g = 0; g < 20; g++) {
    const n = 25 + Math.floor(rnd() * 15);
    const list = rows({ n, nearRate: 0, crit: 5, times: [900, 3000, 9000, 20000, 1500] });
    list.forEach((x, i) => { x.near = rnd() < 0.72; x.cpl = x.near ? 0 : 50; x.found = x.critical && rnd() < 0.55; });
    reports.push(scorePlayer(list, 'w'));
  }
  const acct = accountEvidence(reports);
  assert.ok(acct.evidence < MODEL.reviewAt + 2, `account ${acct.evidence}`);
  assert.notEqual(decide(reports.at(-1), acct), 'suspend');
});

test('coin conversion and address formats', () => {
  assert.equal(toCoin(10_000, 'BTC'), '0.00100000');
  assert.equal(toCoin(10_000, 'USDT'), '100.00');
  assert.ok(COINS.ETH.re.test('0x' + 'a'.repeat(40)));
  assert.ok(!COINS.ETH.re.test('demo-eth-abc'));
  assert.ok(COINS.BTC.re.test('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'));
  assert.ok(!COINS.BTC.re.test('demo-btc-' + 'a'.repeat(28)));
});

test('UCI info parsing', () => {
  const i = parseInfo('info depth 18 seldepth 25 multipv 2 score cp -34 nodes 1000 nps 1 pv e7e5 g1f3');
  assert.equal(i.multipv, 2); assert.equal(i.cp, -34); assert.equal(i.move, 'e7e5');
  assert.equal(parseInfo('info depth 10 score cp 20 lowerbound pv e2e4'), null);
  assert.equal(scoreCp(parseInfo('info depth 5 score mate 3 pv a1a8')), 9970);
  assert.equal(scoreCp(parseInfo('info depth 5 score mate -2 pv a1a8')), -9980);
});

test('chat text is cleaned and capped', () => {
  assert.equal(cleanChat('  hi\u0000 there\n\n  you  '), 'hi there you');
  assert.equal(cleanChat('\u202eabc'), 'abc');
  assert.equal(cleanChat('x'.repeat(500)).length, 200);
  assert.equal(cleanChat(null), '');
});

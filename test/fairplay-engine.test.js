// End-to-end check of the fair-play pipeline with real Stockfish games.
// One side relays engine moves (with steady timing and tab switching), the
// other plays like a strong human: usually a good move, not always the best.
import './helpers.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { EnginePool, scoreCp } from '../src/engine.js';
import { openDb } from '../src/db.js';
import { FairPlay, accountEvidence, decide, MODEL } from '../src/anticheat.js';

const player = new EnginePool(2, 'stockfish', { Threads: 1, Hash: 16 });
const analysis = new EnginePool(2, 'stockfish', { Threads: 1, Hash: 32 });
after(() => { player.quit(); analysis.quit(); });

let seed = 12345;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// Pick among the top lines with probability falling off with the loss.
async function humanMove(fen, temperature = 40) {
  const { lines } = await player.search({ fen, nodes: 40_000, multipv: 5 });
  const best = scoreCp(lines[0]);
  const w = lines.map((l) => Math.exp(-(best - scoreCp(l)) / temperature));
  const sum = w.reduce((a, b) => a + b, 0);
  let r = rnd() * sum;
  for (let i = 0; i < lines.length; i++) { r -= w[i]; if (r <= 0) return lines[i].move; }
  return lines[0].move;
}
// strength: 'full' relays a long search, 'light' a quick depth-12 one.
let relay = 'full';
async function engineMove(fen) {
  const { best } = await player.search(relay === 'full' ? { fen, nodes: 600_000 } : { fen, depth: 12 });
  return best;
}

async function makeGame(cheatColor, plies = 90) {
  const c = new Chess();
  const moves = [];
  const openings = [['e2e4', 'e7e5', 'g1f3', 'b8c6'], ['d2d4', 'g8f6', 'c2c4', 'e7e6'], ['e2e4', 'c7c5', 'g1f3', 'd7d6'], ['c2c4', 'e7e5', 'b1c3', 'g8f6']];
  const book = openings[Math.floor(rnd() * openings.length)];
  for (let i = 0; i < plies && !c.isGameOver(); i++) {
    const side = c.turn();
    let u;
    if (i < book.length) u = book[i];
    else u = side === cheatColor ? await engineMove(c.fen()) : await humanMove(c.fen());
    const mv = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || 'q' });
    const rec = { u: mv.from + mv.to + (mv.promotion || ''), s: mv.san };
    if (side === cheatColor) { rec.t = 3500 + Math.round(rnd() * 1500); rec.b = 1; }
    else rec.t = Math.round(500 + rnd() * rnd() * 40_000);
    moves.push(rec);
  }
  return moves;
}

async function series(maxGames) {
  const db = openDb(':memory:');
  const actions = [];
  const fp = new FairPlay({
    db, pool: analysis, nodes: Number(process.env.FP_NODES || 400_000),
    enforce: {
      suspend: (u, why) => actions.push(['suspend', u, why]),
      review: (u, why) => actions.push(['review', u, why]),
      intervene: () => {},
    },
  });

  const cheater = 1, human = 2;
  const cheatReports = [], humanReports = [];
  let reviewedAfter = null, suspendedAfter = null;
  for (let i = 0; i < maxGames && suspendedAfter === null; i++) {
    const cheatColor = i % 2 === 0 ? 'w' : 'b';
    const moves = await makeGame(cheatColor);
    const game = {
      id: `g${i}`, kind: 'human', moves, status: 'finished',
      white: { userId: cheatColor === 'w' ? cheater : human },
      black: { userId: cheatColor === 'b' ? cheater : human },
    };
    const out = await fp.finishGame(game);
    cheatReports.push(out.find((o) => o.userId === cheater).report);
    humanReports.push(out.find((o) => o.userId === human).report);
    if (reviewedAfter === null && actions.some(([a, u]) => a === 'review' && u === cheater)) reviewedAfter = i + 1;
    if (suspendedAfter === null && actions.some(([a, u]) => a === 'suspend' && u === cheater)) suspendedAfter = i + 1;
  }

  const fmt = (r) => `near ${r.near}/${r.nonTrivial} crit ${r.found}/${r.critical} acpl ${r.acpl} ev ${r.evidence} ${r.verdict}`;
  console.log('cheater:', cheatReports.map(fmt).join(' | '));
  console.log('human:  ', humanReports.map(fmt).join(' | '));
  const cheatAcct = accountEvidence(cheatReports);
  const humanAcct = accountEvidence(humanReports);
  console.log(`account evidence: cheater ${cheatAcct.evidence}, human ${humanAcct.evidence}; cheater reviewed after game ${reviewedAfter}, suspended after game ${suspendedAfter}`);

  db.close();
  return { reviewedAfter, suspendedAfter, actions, humanAcct, humanReports, cheatReports, human };
}

test('full-strength engine relay: frozen within three games, suspended within seven; human untouched', { timeout: 1_800_000 }, async () => {
  relay = 'full';
  const r = await series(7);
  assert.ok(r.reviewedAfter !== null && r.reviewedAfter <= 3, 'withdrawals should freeze within three games');
  assert.ok(r.suspendedAfter !== null && r.suspendedAfter <= 7, 'should be suspended within seven games');
  assert.ok(!r.actions.some(([, u]) => u === r.human), 'human must not be flagged at all');
});

// A quick, shallow engine plays like a very strong human. The model is built
// to leave those games alone rather than risk banning real players, so the
// only hard requirement here is that the human is never touched.
test('light engine relay: scored above the human, human untouched', { timeout: 1_800_000 }, async () => {
  relay = 'light';
  const r = await series(3);
  assert.ok(!r.actions.some(([, u]) => u === r.human), 'human must not be flagged at all');
  assert.ok(r.humanAcct.evidence < MODEL.reviewAt);
  assert.notEqual(decide(r.humanReports.at(-1), r.humanAcct), 'suspend');
  const total = (a) => a.reduce((x, y) => x + y.evidence, 0);
  assert.ok(total(r.cheatReports) > total(r.humanReports));
});

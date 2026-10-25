import { Chess } from 'chess.js';
import { scoreCp } from './engine.js';

// Fair-play model
// ---------------
// Strong play alone never gets anyone banned. The question asked of every
// game is: if this person were an exceptionally strong human, how surprising
// would their moves be? The null hypothesis is deliberately generous (a human
// who plays an engine-equivalent move in 75% of non-trivial positions and
// finds 60% of hard "only moves"). Real titled players sit well below both
// rates at blitz speed, so the p-values we compute are conservative for any
// honest player, however good.
//
// Timing and tab-focus data are easy to fake and easy to trip innocently, so
// they never count on their own. They only add weight once the move quality
// is already statistically unusual.

export const MODEL = {
  bookPlies: 8,           // first four moves each are ignored
  decidedCp: 500,         // positions already won/lost are not informative
  obviousGapCp: 150,      // a capture this much better than anything else is not a "find"
  nearCpl: 10,            // within 10cp of the engine's best = engine-equivalent
  criticalGapCp: 100,     // best move this much better than the 2nd = an "only move"
  criticalFoundCpl: 20,
  pNear: 0.75,
  pCritical: 0.60,
  minNonTrivial: 10,
  minCritical: 3,
  suspiciousAt: 3,        // -log10 scale
  engineLikeAt: 6,
  reviewAt: 4,
  accountSuspendAt: 8,
  singleGameSuspendAt: 7,
  liveInterveneAt: 8,
  historyGames: 20,
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamp(cp, -1000, 1000))) - 1);

// Lichess-style per-move accuracy from the drop in win percentage.
export const moveAccuracy = (before, after) =>
  clamp(103.1668 * Math.exp(-0.04354 * Math.max(0, before - after)) - 3.1669 + 1, 0, 100);

function lnChoose(n, k) {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

// P(X >= k) for X ~ Binomial(n, p)
export function binomTail(k, n, p) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let total = 0;
  for (let i = k; i <= n; i++) total += Math.exp(lnChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return clamp(total, 0, 1);
}

// Fisher's method. With 2k degrees of freedom the chi-square tail has a
// closed form, so this is exact.
export function fisherCombine(ps) {
  const list = ps.filter((p) => p !== null && p !== undefined).map((p) => clamp(p, 1e-300, 1));
  if (!list.length) return 1;
  const half = -list.reduce((s, p) => s + Math.log(p), 0); // x/2
  let term = 1, sum = 1;
  for (let j = 1; j < list.length; j++) { term *= half / j; sum += term; }
  return clamp(Math.exp(-half) * sum, 0, 1);
}

export const lg = (p) => -Math.log10(clamp(p, 1e-300, 1));

// Rebuild the FEN before each ply.
export function positions(moves) {
  const c = new Chess();
  const fens = [c.fen()];
  const meta = [];
  for (const m of moves) {
    const legal = c.moves({ verbose: true });
    meta.push({ legal: legal.length, turn: c.turn() });
    c.move({ from: m.u.slice(0, 2), to: m.u.slice(2, 4), promotion: m.u[4] });
    fens.push(c.fen());
  }
  return { fens, meta, final: c };
}

function moveKind(fen, uci) {
  if (!uci) return { capture: false, check: false };
  try {
    const c = new Chess(fen);
    const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return { capture: !!mv.captured, check: mv.san.includes('+') || mv.san.includes('#') };
  } catch {
    return { capture: false, check: false };
  }
}

// analyses[i] = engine view of the position before ply i (multipv >= 2).
// Returns one row per ply with everything the scorer needs.
export function evaluateMoves(moves, analyses) {
  const { fens, meta, final } = positions(moves);
  const rows = [];
  for (let i = 0; i < moves.length; i++) {
    const a = analyses[i];
    if (!a || !a.lines.length) { rows.push(null); continue; }
    const m = moves[i];
    const best = a.lines[0];
    const bestCp = scoreCp(best);
    let playedCp;
    const inList = a.lines.find((l) => l.move === m.u);
    if (inList) playedCp = scoreCp(inList);
    else if (i + 1 === moves.length && final.isGameOver()) playedCp = final.isCheckmate() ? 10_000 : 0;
    else if (analyses[i + 1]?.lines.length) playedCp = -scoreCp(analyses[i + 1].lines[0]);
    else { rows.push(null); continue; }
    const secondCp = a.lines[1] ? scoreCp(a.lines[1]) : null;
    const gap = secondCp === null ? 1000 : bestCp - secondCp;
    const kind = moveKind(fens[i], best.move);
    const cpl = clamp(bestCp - playedCp, 0, 1000);
    const book = i < MODEL.bookPlies;
    const forced = meta[i].legal <= 1;
    const decided = Math.abs(bestCp) > MODEL.decidedCp;
    const obvious = gap >= MODEL.obviousGapCp && kind.capture;
    const nonTrivial = !book && !forced && !decided && !obvious;
    const critical = nonTrivial && gap >= MODEL.criticalGapCp && !kind.capture && !kind.check;
    rows.push({
      ply: i,
      color: meta[i].turn,
      played: m.u,
      best: best.move,
      bestCp, playedCp, cpl, gap,
      top1: m.u === best.move,
      near: cpl <= MODEL.nearCpl,
      nonTrivial, critical, book, forced, decided, obvious,
      found: critical && cpl <= MODEL.criticalFoundCpl,
      acc: moveAccuracy(winPct(bestCp), winPct(playedCp)),
      t: m.t ?? null,
      blur: (m.b || 0) > 0 || (m.h || 0) > 1000,
    });
  }
  return rows;
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function cv(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  if (m <= 0) return null;
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2))) / m;
}

export function scorePlayer(rows, color) {
  const mine = rows.filter((r) => r && r.color === color);
  const nt = mine.filter((r) => r.nonTrivial);
  const crit = nt.filter((r) => r.critical);
  const nearK = nt.filter((r) => r.near).length;
  const foundK = crit.filter((r) => r.found).length;
  const afterBook = mine.filter((r) => !r.book);

  // A test that could not run (too few positions) is left out entirely;
  // feeding Fisher a p of 1 would dilute the tests that did run.
  const pNear = nt.length >= MODEL.minNonTrivial ? binomTail(nearK, nt.length, MODEL.pNear) : null;
  const pCrit = crit.length >= MODEL.minCritical ? binomTail(foundK, crit.length, MODEL.pCritical) : null;
  const precision = lg(fisherCombine([pNear, pCrit]));

  // Corroborating signals.
  const timed = nt.filter((r) => r.t !== null && r.t >= 300).map((r) => r.t);
  const timeCv = timed.length >= 12 ? cv(timed) : null;
  const critTimes = crit.filter((r) => r.t !== null).map((r) => r.t);
  const quietTimes = nt.filter((r) => !r.critical && r.t !== null).map((r) => r.t);
  const timeRatio = critTimes.length >= 3 && quietTimes.length >= 5 && mean(quietTimes) > 0 ? mean(critTimes) / mean(quietTimes) : null;
  const blurRate = afterBook.length ? afterBook.filter((r) => r.blur).length / afterBook.length : 0;

  // Behaviour is measured on every game but only counts once the moves are
  // already unusual (p < 0.1 for this game).
  let corroboration = 0;
  const notes = [];
  if (timeCv !== null && timeCv < 0.35) { corroboration += 1; notes.push('very even move times'); }
  else if (timeCv !== null && timeCv < 0.5) { corroboration += 0.5; notes.push('unusually even move times'); }
  if (timeRatio !== null && timeRatio < 1.15) { corroboration += 0.5; notes.push('no extra time spent on hard moves'); }
  if (blurRate >= 0.5) { corroboration += 1.5; notes.push('left the tab on most moves'); }
  else if (blurRate >= 0.25) { corroboration += 0.75; notes.push('left the tab often'); }
  const counted = precision >= 1 ? corroboration : 0;

  const evidence = +(precision + counted).toFixed(2);
  const enough = nt.length >= MODEL.minNonTrivial;
  const verdict = !enough ? 'insufficient' : evidence >= MODEL.engineLikeAt ? 'engine-like' : evidence >= MODEL.suspiciousAt ? 'suspicious' : 'clean';

  return {
    color,
    moves: mine.length,
    nonTrivial: nt.length,
    near: nearK,
    nearRate: nt.length ? +(nearK / nt.length).toFixed(3) : null,
    top1Rate: nt.length ? +(nt.filter((r) => r.top1).length / nt.length).toFixed(3) : null,
    critical: crit.length,
    found: foundK,
    acpl: nt.length ? Math.round(mean(nt.map((r) => r.cpl))) : null,
    accuracy: afterBook.length ? +mean(afterBook.map((r) => r.acc)).toFixed(1) : null,
    pNear, pCrit,
    precision: +precision.toFixed(2),
    timeCv: timeCv === null ? null : +timeCv.toFixed(2),
    timeRatio: timeRatio === null ? null : +timeRatio.toFixed(2),
    blurRate: +blurRate.toFixed(2),
    corroboration,
    notes,
    evidence,
    verdict,
  };
}

// Combine a player's recent games. Each game contributes its two p-values;
// Fisher's method treats them as independent tests.
// Pool the move counts over recent games and test them together. With a
// steady effect this is far more powerful than combining per-game p-values,
// and it is just as valid under the human baseline.
export function accountEvidence(reports) {
  const usable = reports.filter((r) => r.verdict !== 'insufficient');
  const sum = (k) => usable.reduce((s, r) => s + (r[k] || 0), 0);
  const nt = sum('nonTrivial'), near = sum('near'), crit = sum('critical'), found = sum('found');
  const pNear = nt >= MODEL.minNonTrivial ? binomTail(near, nt, MODEL.pNear) : null;
  const pCrit = crit >= MODEL.minCritical ? binomTail(found, crit, MODEL.pCritical) : null;
  const precision = lg(fisherCombine([pNear, pCrit]));
  // Behaviour across all games, counted only when the pooled move quality
  // is already significant (p < 0.01).
  const corroboration = usable.length ? Math.min(2.5, mean(usable.map((r) => r.corroboration))) : 0;
  const suspiciousGames = usable.filter((r) => r.verdict === 'suspicious' || r.verdict === 'engine-like').length;
  return {
    games: usable.length,
    nearRate: nt ? +(near / nt).toFixed(3) : null,
    precision: +precision.toFixed(2),
    corroboration: +corroboration.toFixed(2),
    evidence: +(precision + (precision >= 2 ? corroboration : 0)).toFixed(2),
    suspiciousGames,
  };
}

// What to do about an account, given its latest game and its history.
export function decide(latest, account) {
  if (account.evidence >= MODEL.accountSuspendAt && account.games >= 3 && account.suspiciousGames >= 1) return 'suspend';
  if (latest && latest.evidence >= MODEL.singleGameSuspendAt && latest.corroboration >= 1.5 &&
      latest.nonTrivial >= 25 && latest.nearRate >= 0.95 && latest.acpl <= 8) return 'suspend';
  if (account.evidence >= MODEL.reviewAt || (latest && latest.verdict !== 'clean' && latest.verdict !== 'insufficient')) return 'review';
  return 'none';
}

// Plain-language summary for the admin screen.
export function describe(r) {
  if (r.verdict === 'insufficient') return `Only ${r.nonTrivial} non-trivial positions; not enough to judge.`;
  const parts = [
    `Engine-level move in ${r.near} of ${r.nonTrivial} non-trivial positions (${Math.round(r.nearRate * 100)}%).`,
  ];
  if (r.critical >= MODEL.minCritical) parts.push(`Found ${r.found} of ${r.critical} hard only-moves.`);
  parts.push(`Average loss ${r.acpl} centipawns.`);
  if (r.notes.length) parts.push(`Also: ${r.notes.join(', ')}.`);
  return parts.join(' ');
}

// Service: runs Stockfish over games (incrementally while they are being
// played) and feeds the results into the decision rules above.
export class FairPlay {
  constructor({ db, pool, nodes, enforce }) {
    this.db = db;
    this.pool = pool;
    this.nodes = nodes;
    this.enforce = enforce; // { review(userId, why, gameId), suspend(userId, why, gameId), intervene(game, color, why) }
    this.live = new Map(); // gameId -> { analyses: [], pending: Map }
  }

  analyse(fen) {
    return this.pool.search({ fen, nodes: this.nodes, multipv: 4 });
  }

  liveState(gameId) {
    let s = this.live.get(gameId);
    if (!s) { s = { analyses: [], pending: new Map() }; this.live.set(gameId, s); }
    return s;
  }

  // Called after every move of a monitored game.
  onMove(game) {
    const s = this.liveState(game.id);
    const { fens } = positions(game.moves);
    const ply = game.moves.length - 1;
    for (const p of [ply, ply + 1]) {
      if (p >= fens.length || s.analyses[p] || s.pending.has(p)) continue;
      const job = this.analyse(fens[p]).then((a) => { s.analyses[p] = a; s.pending.delete(p); }).catch(() => s.pending.delete(p));
      s.pending.set(p, job);
    }
    // Live check every few moves once there is something to look at.
    if (ply >= 30 && ply % 4 === 0) this.liveCheck(game).catch(() => {});
  }

  async liveCheck(game) {
    const s = this.liveState(game.id);
    await Promise.all(s.pending.values());
    if (game.status !== 'active' || this.closed) return;
    const rows = evaluateMoves(game.moves.slice(0, s.analyses.length - 1), s.analyses);
    for (const color of ['w', 'b']) {
      const userId = color === 'w' ? game.white.userId : game.black.userId;
      if (!userId) continue;
      const current = scorePlayer(rows, color);
      if (current.verdict !== 'engine-like' && current.verdict !== 'suspicious') continue;
      const account = accountEvidence([current, ...(await this.history(userId))]);
      if (account.evidence >= MODEL.liveInterveneAt) {
        await this.enforce.intervene(game, color, `Live check: ${describe(current)}`);
        return;
      }
    }
  }

  async history(userId) {
    const rows = await this.db.fair_play_reports.find({ user_id: userId }, { projection: { metrics: 1 }, sort: { created_at: -1 }, limit: MODEL.historyGames });
    return rows.map((r) => r.metrics);
  }

  // Full pass when a game ends. Returns the reports written.
  async finishGame(game) {
    const s = this.liveState(game.id);
    this.live.delete(game.id);
    if (game.moves.length < 2) return [];
    await Promise.all(s.pending.values());
    const { fens } = positions(game.moves);
    const analyses = s.analyses.slice();
    await Promise.all(fens.map(async (fen, i) => {
      if (!analyses[i] && i < fens.length - 1) analyses[i] = await this.analyse(fen);
    }));
    if (this.closed) return [];
    const rows = evaluateMoves(game.moves, analyses);
    const out = [];
    for (const color of ['w', 'b']) {
      const side = color === 'w' ? game.white : game.black;
      if (!side.userId) continue;
      const report = scorePlayer(rows, color);
      report.summary = describe(report);
      await this.db.fair_play_reports.replace(
        { game_id: game.id, user_id: side.userId },
        { game_id: game.id, user_id: side.userId, evidence: report.evidence, verdict: report.verdict, metrics: report, created_at: Date.now() },
        { upsert: true },
      );
      out.push({ userId: side.userId, report });
      const account = accountEvidence(await this.history(side.userId));
      const action = decide(report, account);
      const why = `${describe(report)} Account evidence ${account.evidence} over ${account.games} games.`;
      if (action === 'suspend') await this.enforce.suspend(side.userId, why, game.id);
      else if (action === 'review') await this.enforce.review(side.userId, why, game.id);
    }
    return out;
  }
}

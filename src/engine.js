import { spawn } from 'node:child_process';

// Thin UCI driver for a native Stockfish process. One search at a time per
// process; EnginePool spreads work over several processes.
export class Engine {
  constructor(path, options = {}) {
    this.path = path;
    this.options = options;
    this.queue = Promise.resolve();
    this.multipv = 1;
    this.dead = false;
    this.start();
  }

  start() {
    this.proc = spawn(this.path, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.buf = '';
    this.listeners = new Set();
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        for (const fn of this.listeners) fn(line);
      }
    });
    this.proc.on('exit', () => {
      for (const fn of this.listeners) fn('__exit__');
      if (!this.dead) setTimeout(() => this.start(), 250);
    });
    this.proc.on('error', (err) => { this.startError = err; });
    this.send('uci');
    for (const [k, v] of Object.entries(this.options)) this.send(`setoption name ${k} value ${v}`);
    this.multipv = 1;
    this.ready = this.waitFor((l) => l === 'readyok', 'isready');
  }

  send(cmd) {
    if (this.proc.stdin.writable) this.proc.stdin.write(cmd + '\n');
  }

  waitFor(pred, cmd, onLine) {
    return new Promise((resolve, reject) => {
      const fn = (line) => {
        if (line === '__exit__') { this.listeners.delete(fn); reject(new Error('stockfish exited')); return; }
        onLine?.(line);
        if (pred(line)) { this.listeners.delete(fn); resolve(line); }
      };
      this.listeners.add(fn);
      if (cmd) this.send(cmd);
    });
  }

  // search({ fen, movetime | nodes | depth, multipv }) -> { best, lines: [{ move, cp, mate, pv, depth }] }
  search({ fen, movetime, nodes, depth, multipv = 1 }) {
    const job = async () => {
      await this.ready;
      if (multipv !== this.multipv) {
        this.send(`setoption name MultiPV value ${multipv}`);
        this.multipv = multipv;
      }
      this.send(`position fen ${fen}`);
      const lines = [];
      const go = movetime ? `go movetime ${Math.max(10, Math.round(movetime))}` : nodes ? `go nodes ${nodes}` : `go depth ${depth || 12}`;
      const bestLine = await this.waitFor((l) => l.startsWith('bestmove'), go, (line) => {
        if (!line.startsWith('info') || !line.includes(' pv ')) return;
        const info = parseInfo(line);
        if (info) lines[info.multipv - 1] = info;
      });
      const best = bestLine.split(/\s+/)[1];
      return { best: best === '(none)' ? null : best, lines: lines.filter(Boolean) };
    };
    const p = this.queue.then(job, job);
    this.queue = p.catch(() => {});
    return p;
  }

  quit() {
    this.dead = true;
    try { this.send('quit'); } catch {}
    setTimeout(() => { try { this.proc.kill(); } catch {} }, 200).unref();
  }
}

export function parseInfo(line) {
  const t = line.split(/\s+/);
  const out = { multipv: 1, depth: 0, cp: null, mate: null, pv: [] };
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth': out.depth = +t[++i]; break;
      case 'multipv': out.multipv = +t[++i]; break;
      case 'score':
        if (t[i + 1] === 'cp') out.cp = +t[i + 2];
        else if (t[i + 1] === 'mate') out.mate = +t[i + 2];
        i += 2;
        if (t[i + 1] === 'lowerbound' || t[i + 1] === 'upperbound') return null;
        break;
      case 'pv': out.pv = t.slice(i + 1); i = t.length; break;
    }
  }
  if (out.cp === null && out.mate === null) return null;
  out.move = out.pv[0];
  return out;
}

// Score in centipawns from the side to move, mates squashed to +-10000.
export const scoreCp = (line) => {
  if (!line) return 0;
  if (line.mate !== null) return line.mate > 0 ? 10_000 - line.mate * 10 : -10_000 - line.mate * 10;
  return line.cp;
};

export class EnginePool {
  constructor(size, path, options) {
    this.engines = Array.from({ length: Math.max(1, size) }, () => new Engine(path, options));
    this.free = [...this.engines];
    this.waiting = [];
  }
  async run(fn) {
    const engine = this.free.pop() || (await new Promise((r) => this.waiting.push(r)));
    try { return await fn(engine); }
    finally {
      const next = this.waiting.shift();
      if (next) next(engine); else this.free.push(engine);
    }
  }
  search(opts) { return this.run((e) => e.search(opts)); }
  get busy() { return this.engines.length - this.free.length + this.waiting.length; }
  quit() { this.engines.forEach((e) => e.quit()); }
}

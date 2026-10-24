// Shared harness: boots the real app on a random port with an in-memory DB.
const emit = process.emitWarning;
process.emitWarning = (w, ...r) => (String(w?.message || w).includes('SQLite') ? undefined : emit.call(process, w, ...r));

process.env.BOT_MOVE_SCALE ??= '0.05';
process.env.BOT_ENGINES ??= '1';
process.env.BOT_THREADS ??= '1';
process.env.BOT_HASH_MB ??= '16';
process.env.ANALYSIS_ENGINES ??= '2';
process.env.ANALYSIS_NODES ??= '20000';
process.env.DEPOSIT_CONFIRM_MS ??= '20';
process.env.WITHDRAW_PROCESS_MS ??= '30';
process.env.MATCH_TICK_MS ??= '50';
process.env.SCHEDULE_TICK_MS ??= '3600000';
process.env.REGISTER_PER_HOUR ??= '100000';
process.env.LOGIN_PER_MINUTE ??= '100000';

import WebSocket from 'ws';

export async function boot(extra = {}) {
  const { createApp } = await import('../src/app.js');
  const app = await createApp({ dbPath: ':memory:', ...extra });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, base, close: () => app.ctx.close() };
}

export class Client {
  constructor(base) { this.base = base; this.cookies = {}; this.msgs = []; this.waiters = []; }
  cookieHeader() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(path, body, { method, headers = {} } = {}) {
    const res = await fetch(this.base + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { 'x-cb': '1', cookie: this.cookieHeader(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (v) this.cookies[k] = v; else delete this.cookies[k];
    }
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }
  async register(username, password = 'password123') {
    await this.req('/api/config');
    const r = await this.req('/api/register', { username, password, adult: true, terms: true });
    if (r.status !== 200) throw new Error(`register ${username}: ${JSON.stringify(r.data)}`);
    this.user = r.data.user;
    return r.data.user;
  }
  async fund(amount, coin = 'USDT') {
    await this.req('/api/wallet/address', { coin });
    const r = await this.req('/api/wallet/deposit', { coin, amount });
    if (r.status !== 200) throw new Error(JSON.stringify(r.data));
    for (let i = 0; i < 100; i++) {
      const w = await this.req('/api/wallet');
      if (w.data.deposits.every((d) => d.status === 'credited')) return w.data.user.balance;
      await sleep(20);
    }
    throw new Error('deposit never credited');
  }
  async connect() {
    this.ws = new WebSocket(this.base.replace('http', 'ws') + '/ws', { headers: { cookie: this.cookieHeader(), origin: this.base } });
    this.ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'ping') return this.send({ t: 'pong', ts: m.ts });
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
    await new Promise((r, j) => { this.ws.once('open', r); this.ws.once('error', j); });
    await this.wait((m) => m.t === 'hello');
    return this;
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  wait(pred, ms = 8000) {
    const hit = this.msgs.find(pred);
    if (hit) { this.msgs.splice(this.msgs.indexOf(hit), 1); return Promise.resolve(hit); }
    return new Promise((resolve, reject) => {
      const w = { pred, resolve: (m) => { clearTimeout(t); this.msgs.splice(this.msgs.indexOf(m), 1); resolve(m); } };
      const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error(`timeout waiting; got ${this.msgs.map((x) => x.t).join(',')}`)); }, ms);
      this.waiters.push(w);
    });
  }
  async balance() { return (await this.req('/api/me')).data.user.balance; }
  close() { this.ws?.close(); }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sum of each user's ledger must equal their balance, and money is conserved:
// deposits - withdrawals = user balances + open holds + house net.
export function checkBooks(db) {
  for (const u of db.all('SELECT id, balance FROM users')) {
    const s = db.get('SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE user_id = ?', u.id).s;
    if (s !== u.balance) throw new Error(`user ${u.id}: ledger ${s} != balance ${u.balance}`);
  }
  const deposits = db.get("SELECT COALESCE(SUM(amount),0) s FROM deposits WHERE status IN ('credited','forfeited')").s;
  const paidOut = db.get("SELECT COALESCE(SUM(net),0) s FROM withdrawals WHERE status = 'completed'").s;
  const inFlight = db.get("SELECT COALESCE(SUM(amount),0) s FROM withdrawals WHERE status IN ('processing','review')").s;
  const balances = db.get('SELECT COALESCE(SUM(balance),0) s FROM users').s;
  const held = db.get("SELECT COALESCE(SUM(amount),0) s FROM holds WHERE status = 'held'").s;
  const house = db.get('SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE user_id IS NULL').s;
  const lhs = deposits - paidOut - inFlight;
  const rhs = balances + held + house;
  if (lhs !== rhs) throw new Error(`money not conserved: in ${lhs} vs accounted ${rhs} (bal ${balances}, held ${held}, house ${house})`);
  return true;
}

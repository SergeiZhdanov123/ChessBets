import { api, emitter } from './lib.js';

// Shared client state plus the WebSocket connection.
export const bus = emitter();

export const store = {
  user: null,
  config: null,
  counts: {},
  queue: null,       // { key, tc, stake, joinedAt }
  activeGame: null,
  online: 0,
  set(patch) {
    Object.assign(this, patch);
    bus.emit('store', patch);
  },
};

export async function loadConfig() {
  const [cfg, me] = await Promise.all([api('/api/config'), api('/api/me')]);
  store.set({ config: cfg, counts: cfg.counts, user: me.user, activeGame: me.activeGame, queue: me.queue });
}

export async function refreshMe() {
  const me = await api('/api/me');
  store.set({ user: me.user, activeGame: me.activeGame, queue: me.queue });
  return me;
}

// ---- socket ----
let sock = null;
let backoff = 500;
let outbox = [];

export const ws = {
  open: false,
  send(msg) {
    if (sock && sock.readyState === 1) sock.send(JSON.stringify(msg));
    else outbox.push(msg);
  },
  // Re-open so the server sees the new session cookie after sign-in/out.
  reconnect() {
    if (sock) { sock.onclose = null; sock.close(); }
    connect();
  },
};

export function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  sock = new WebSocket(url);
  sock.onopen = () => {
    ws.open = true;
    backoff = 500;
    const q = outbox; outbox = [];
    q.forEach((m) => ws.send(m));
    bus.emit('ws-open');
  };
  sock.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.t === 'ping') { ws.send({ t: 'pong', ts: msg.ts }); return; }
    // An admin made the site unavailable: reloading shows the notice.
    if (msg.t === 'site-offline') { sock.onclose = null; location.reload(); return; }
    if (msg.t === 'hello') {
      store.set({ counts: msg.queues, online: msg.online, ...(msg.user !== undefined ? { user: msg.user, activeGame: msg.activeGame ?? null, queue: msg.queue ?? null } : {}) });
    }
    if (msg.t === 'queues') store.set({ counts: msg.counts });
    if (msg.t === 'balance' && store.user) {
      const prev = store.user.balance;
      store.set({ user: { ...store.user, balance: msg.balance, held: msg.held, status: msg.status } });
      if (msg.balance > prev) bus.emit('balance-up');
    }
    if (msg.t === 'queue') store.set({ queue: msg.state === 'joined' ? { key: msg.key, tc: msg.tc, stake: msg.stake, joinedAt: msg.joinedAt } : null });
    if (msg.t === 'matched') store.set({ queue: null, activeGame: msg.id });
    bus.emit(msg.t, msg);
  };
  sock.onclose = () => {
    ws.open = false;
    bus.emit('ws-close');
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 8000);
  };
}

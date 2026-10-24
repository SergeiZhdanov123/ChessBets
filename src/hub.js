import { WebSocketServer } from 'ws';

export const CHAT_PRESETS = ['Good luck', 'Have fun', 'Good game', 'Well played', 'Thanks', 'Oops'];

// WebSocket fan-out plus the in-game message handlers.
export function createHub(ctx) {
  const conns = new Set();
  const byUser = new Map();
  const subs = new Map(); // gameId -> Set(conn)

  const send = (conn, msg) => { if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(msg)); };

  const hub = {
    conns,
    toUser(userId, msg) { for (const c of byUser.get(userId) || []) send(c, msg); },
    // msg may be a function of the connection, for per-viewer snapshots.
    toGame(gameId, msg) { for (const c of subs.get(gameId) || []) send(c, typeof msg === 'function' ? msg(c) : msg); },
    all(msg) { const s = JSON.stringify(msg); for (const c of conns) if (c.ws.readyState === 1) c.ws.send(s); },
    feed(rows) { if (rows?.length) hub.all({ t: 'feed', rows }); },
    pushBalance(userId) {
      const u = ctx.db.get('SELECT balance, status FROM users WHERE id = ?', userId);
      if (u) hub.toUser(userId, { t: 'balance', balance: u.balance, held: ctx.money.heldTotal(userId), status: u.status });
    },
    // Signed-in people plus guest connections.
    online: () => byUser.size + [...conns].filter((c) => !c.userId).length,
  };

  function subscribe(conn, gameId) {
    let s = subs.get(gameId);
    if (!s) { s = new Set(); subs.set(gameId, s); }
    s.add(conn);
    conn.games.add(gameId);
  }

  function userConnected(userId) { return (byUser.get(userId)?.size || 0) > 0; }

  function handle(conn, msg) {
    const user = conn.userId ? ctx.db.get('SELECT * FROM users WHERE id = ?', conn.userId) : null;
    const reply = (m) => send(conn, m);
    const err = (message, extra = {}) => reply({ t: 'error', message, ...extra });

    switch (msg.t) {
      case 'pong':
        if (typeof msg.ts === 'number') conn.rtt = Math.min(5000, Math.max(0, Date.now() - msg.ts));
        return;

      case 'sub': {
        const g = ctx.games.get(String(msg.id || ''));
        if (!g) {
          // Finished games come from the database.
          const row = ctx.api.gameRow(String(msg.id || ''), conn.userId);
          return row ? reply({ t: 'game', game: row }) : err('Game not found', { code: 'not_found' });
        }
        const color = conn.userId ? g.colorOf(conn.userId) : null;
        if (g.status === 'active' && !color) return err('Live games are private to the two players', { code: 'private' });
        subscribe(conn, g.id);
        if (color && g.status === 'active') {
          // Two different browsers driving one seat at once is worth noting.
          const others = [...(subs.get(g.id) || [])].filter((c) => c !== conn && c.userId === conn.userId && c.device !== conn.device);
          if (others.length) ctx.enforcement.event(conn.userId, g.id, 'multi_device', 'Game opened on two devices at once');
          g.presence(color, true);
        }
        return reply({ t: 'game', game: g.snapshot(conn.userId) });
      }

      case 'move': case 'resign': case 'abort': case 'draw-offer': case 'draw-accept': case 'draw-decline': case 'chat': {
        if (!user) return err('Sign in first');
        const g = ctx.games.get(String(msg.id || ''));
        if (!g) return err('Game not found');
        const color = g.colorOf(user.id);
        if (!color) return err('Not your game');
        let e = null;
        if (msg.t === 'move') {
          e = g.move(color, msg.u, { ply: msg.ply, blur: msg.blur, hidden: msg.hidden, lagComp: Math.round((conn.rtt || 0) / 2) });
          if (e) reply({ t: 'reject', id: g.id, message: e, game: g.snapshot(user.id) });
          return;
        }
        if (msg.t === 'resign') g.resign(color);
        if (msg.t === 'abort') e = g.abort(color);
        if (msg.t === 'draw-offer') e = g.offerDraw(color);
        if (msg.t === 'draw-accept') e = g.acceptDraw(color);
        if (msg.t === 'draw-decline') g.declineDraw(color);
        if (msg.t === 'chat') {
          if (g.kind !== 'human') return;
          const text = CHAT_PRESETS[msg.k | 0];
          const recent = g.chat.filter((c) => c.c === color && Date.now() - c.at < 5000).length;
          if (text && recent < 2) g.addChat(color, text);
        }
        if (e) err(e);
        return;
      }

      case 'queue-join': {
        if (!user) return err('Sign in first', { code: 'auth' });
        try {
          const r = ctx.matchmaker.join(user, msg.tc, msg.stake, { ip: conn.ip, device: conn.device });
          reply({ t: 'queue', state: 'joined', ...r, tc: Number(msg.tc), stake: Number(msg.stake) });
        } catch (e2) {
          err(e2.message, { code: e2.code });
        }
        return;
      }
      case 'queue-leave':
        if (user) ctx.matchmaker.leave(user.id);
        return;
    }
  }

  hub.attach = (server) => {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      if (!req.url.startsWith('/ws')) return socket.destroy();
      const origin = req.headers.origin;
      if (origin && !ctx.api.sameOrigin(origin, req.headers.host)) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    wss.on('connection', (ws, req) => {
      const auth = ctx.api.authFromRequest(req);
      const conn = { ws, userId: auth.user?.id || null, device: auth.device, ip: auth.ip, rtt: 0, games: new Set(), bucket: { n: 0, at: Date.now() } };
      conns.add(conn);
      if (conn.userId) {
        if (!byUser.has(conn.userId)) byUser.set(conn.userId, new Set());
        byUser.get(conn.userId).add(conn);
        clearTimeout(ctx.queueGrace?.get(conn.userId));
        ctx.enforcement.seenDevice(conn.userId, conn.device, conn.ip);
      }
      send(conn, ctx.api.hello(conn.userId));

      ws.on('message', (data) => {
        const b = conn.bucket;
        const t = Date.now();
        if (t - b.at > 2000) { b.at = t; b.n = 0; }
        if (++b.n > 40) return; // flood: drop
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (!msg || typeof msg.t !== 'string') return;
        try { handle(conn, msg); } catch (e) { console.error('ws handler', e); }
      });

      ws.on('close', () => {
        conns.delete(conn);
        for (const id of conn.games) subs.get(id)?.delete(conn);
        if (!conn.userId) return;
        byUser.get(conn.userId)?.delete(conn);
        if (userConnected(conn.userId)) return;
        byUser.delete(conn.userId);
        const g = ctx.games.activeFor(conn.userId);
        if (g) g.presence(g.colorOf(conn.userId), false);
        // A page reload reconnects within a second or two; give it a moment
        // before dropping someone out of a queue.
        const uid = conn.userId;
        ctx.queueGrace.set(uid, setTimeout(() => { if (!userConnected(uid)) ctx.matchmaker.leave(uid, 'disconnected'); }, 8000));
      });
    });

    const ping = setInterval(() => { const ts = Date.now(); for (const c of conns) send(c, { t: 'ping', ts }); }, 5000);
    ping.unref?.();
    hub.close = () => { clearInterval(ping); for (const c of conns) c.ws.terminate(); wss.close(); };
  };

  return hub;
}

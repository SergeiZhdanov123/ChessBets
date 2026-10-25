import { WebSocketServer } from 'ws';

export const CHAT_PRESETS = ['Good luck', 'Have fun', 'Good game', 'Well played', 'Thanks', 'Oops'];
export const CHAT_MAX = 200;

// Typed chat: printable text only, whitespace collapsed, capped in length.
export function cleanChat(raw) {
  return String(raw ?? '')
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_MAX);
}

// WebSocket fan-out plus the in-game message handlers.
export function createHub(ctx) {
  const conns = new Set();
  const byUser = new Map();
  const subs = new Map(); // gameId -> Set(conn)
  const pushing = new Map();

  const send = (conn, msg) => { if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(msg)); };

  const hub = {
    conns,
    toUser(userId, msg) { for (const c of byUser.get(userId) || []) send(c, msg); },
    // msg may be a function of the connection, for per-viewer snapshots.
    toGame(gameId, msg) {
      for (const c of subs.get(gameId) || []) {
        const m = typeof msg === 'function' ? msg(c) : msg;
        if (m) send(c, m);
      }
    },
    all(msg) { const s = JSON.stringify(msg); for (const c of conns) if (c.ws.readyState === 1) c.ws.send(s); },
    feed(rows) { if (rows?.length) hub.all({ t: 'feed', rows }); },
    // Reads the balance and sends it. Calls that land while a read is in
    // flight fold into one more read after it, so the last message a client
    // gets is always the newest balance.
    pushBalance(userId) {
      if (!byUser.has(userId)) return;
      const running = pushing.get(userId);
      if (running) { running.again = true; return; }
      const state = { again: true };
      pushing.set(userId, state);
      (async () => {
        while (state.again && !ctx.closed) {
          state.again = false;
          const u = await ctx.db.users.findOne({ _id: userId }, { projection: { balance: 1, status: 1 } });
          if (u) hub.toUser(userId, { t: 'balance', balance: u.balance, held: await ctx.money.heldTotal(userId), status: u.status });
        }
      })().catch(() => {}).finally(() => pushing.delete(userId));
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

  // Game messages are handled synchronously, in the order they arrive. Only
  // queue joins and finished-game lookups wait on the database.
  function handle(conn, msg) {
    const userId = conn.userId;
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
          ctx.api.gameRow(String(msg.id || ''), userId)
            .then((row) => (row ? reply({ t: 'game', game: row }) : err('Game not found', { code: 'not_found' })))
            .catch(() => err('Game not found', { code: 'not_found' }));
          return;
        }
        const color = conn.userId ? g.colorOf(conn.userId) : null;
        if (g.status === 'active' && !color) return err('Live games are private to the two players', { code: 'private' });
        subscribe(conn, g.id);
        if (color && g.status === 'active') {
          // Two different browsers driving one seat at once is worth noting.
          const others = [...(subs.get(g.id) || [])].filter((c) => c !== conn && c.userId === conn.userId && c.device !== conn.device);
          if (others.length) ctx.enforcement.event(conn.userId, g.id, 'multi_device', 'Game opened on two devices at once').catch(() => {});
          g.presence(color, true);
        }
        return reply({ t: 'game', game: g.snapshot(conn.userId) });
      }

      case 'move': case 'resign': case 'abort': case 'draw-offer': case 'draw-accept': case 'draw-decline': case 'chat': {
        if (!userId) return err('Sign in first');
        const g = ctx.games.get(String(msg.id || ''));
        if (!g) return err('Game not found');
        const color = g.colorOf(userId);
        if (!color) return err('Not your game');
        let e = null;
        if (msg.t === 'move') {
          e = g.move(color, msg.u, { ply: msg.ply, blur: msg.blur, hidden: msg.hidden, lagComp: Math.round((conn.rtt || 0) / 2) });
          if (e) reply({ t: 'reject', id: g.id, message: e, game: g.snapshot(userId) });
          return;
        }
        if (msg.t === 'resign') g.resign(color);
        if (msg.t === 'abort') e = g.abort(color);
        if (msg.t === 'draw-offer') e = g.offerDraw(color);
        if (msg.t === 'draw-accept') e = g.acceptDraw(color);
        if (msg.t === 'draw-decline') g.declineDraw(color);
        if (msg.t === 'chat') {
          if (g.kind !== 'human') return err('Chat is only for games against people');
          const text = typeof msg.text === 'string' ? cleanChat(msg.text) : CHAT_PRESETS[msg.k | 0];
          if (!text) return;
          const mine = g.chat.filter((c) => c.c === color);
          if (mine.filter((c) => Date.now() - c.at < 5000).length >= 3) return err('Slow down a little', { code: 'chat' });
          if (mine.length >= 100) return err('Chat limit reached for this game', { code: 'chat' });
          g.addChat(color, text);
        }
        if (e) err(e);
        return;
      }

      case 'queue-join': {
        if (!userId) return err('Sign in first', { code: 'auth' });
        (async () => {
          const user = await ctx.db.users.findOne({ _id: userId });
          if (!user) return err('Sign in first', { code: 'auth' });
          const r = await ctx.matchmaker.join(user, msg.tc, msg.stake, { ip: conn.ip, device: conn.device });
          if (!r.cancelled) reply({ t: 'queue', state: 'joined', ...r, tc: Number(msg.tc), stake: Number(msg.stake) });
        })().catch((e2) => {
          if (!e2.code) console.error('queue join', e2);
          err(e2.code ? e2.message : 'Could not join the queue', { code: e2.code });
        });
        return;
      }
      case 'queue-leave':
        if (userId) ctx.matchmaker.leave(userId).catch((e2) => console.error('queue leave', e2.message));
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
      const conn = { ws, userId: null, device: null, ip: null, rtt: 0, games: new Set(), bucket: { n: 0, at: Date.now() } };
      conns.add(conn);
      // Handlers are attached right away; messages that arrive before the
      // session lookup finishes wait for it, still in order.
      conn.ready = (async () => {
        const auth = await ctx.api.authFromRequest(req);
        Object.assign(conn, { userId: auth.user?.id || null, admin: !!auth.user?.is_admin, device: auth.device, ip: auth.ip });
        if (ctx.site.maintenance && !conn.admin) return sendAway(conn);
        if (conn.userId) {
          if (!byUser.has(conn.userId)) byUser.set(conn.userId, new Set());
          byUser.get(conn.userId).add(conn);
          clearTimeout(ctx.queueGrace?.get(conn.userId));
          ctx.enforcement.seenDevice(conn.userId, conn.device, conn.ip).catch(() => {});
        }
        send(conn, await ctx.api.hello(conn.userId));
      })().catch((e) => {
        if (!ctx.closed) console.error('ws connect', e.message);
        ws.close(1011);
      });

      ws.on('message', (data) => {
        const b = conn.bucket;
        const t = Date.now();
        if (t - b.at > 2000) { b.at = t; b.n = 0; }
        if (++b.n > 40) return; // flood: drop
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (!msg || typeof msg.t !== 'string') return;
        conn.ready.then(() => {
          if (ctx.closed) return;
          try { handle(conn, msg); } catch (e) { console.error('ws handler', e); }
        });
      });

      ws.on('close', () => {
        conns.delete(conn);
        conn.ready.then(() => disconnected(conn));
      });
    });

    // Site made unavailable: the page reloads into the notice.
    function sendAway(conn) {
      send(conn, { t: 'site-offline' });
      conn.ws.close(4503);
    }
    hub.sendPlayersAway = () => {
      for (const c of conns) c.ready.then(() => { if (!c.admin && c.ws.readyState === 1) sendAway(c); });
    };

    function disconnected(conn) {
      if (ctx.closed) return; // shutting down: no presence or queue timers
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
      ctx.queueGrace.set(uid, setTimeout(() => {
        if (!userConnected(uid)) ctx.matchmaker.leave(uid, 'disconnected').catch(() => {});
      }, 8000));
    }

    const ping = setInterval(() => { const ts = Date.now(); for (const c of conns) send(c, { t: 'ping', ts }); }, 5000);
    ping.unref?.();
    hub.close = () => { clearInterval(ping); for (const c of conns) c.ws.terminate(); wss.close(); };
  };

  return hub;
}

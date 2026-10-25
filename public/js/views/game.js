import { Chess } from '/vendor/chess.js';
import { esc, money, icon, clock, reasonText, confirmBox, toast } from '../lib.js';
import { store, bus, ws, refreshMe } from '../store.js';
import { Board } from '../board.js';
import { sound } from '../sound.js';
import { userAvatar } from '../avatars.js';

const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const START = { p: 8, n: 2, b: 2, r: 2, q: 1 };

export default function gameView(el, [id]) {
  el.innerHTML = `
    <div class="stage">
      <div class="panel" id="gp"><div class="skel" style="height:200px"></div></div>
      <div class="arena">
        <div class="arena-main">
          <div class="board-wrap" id="bw" style="position:relative">
            <div class="pbar" id="top"></div>
            <div style="position:relative"><div id="bd"></div><div id="res"></div></div>
            <div class="pbar" id="bot"></div>
          </div>
        </div>
        <div class="stage-foot">
          <button class="icon-btn" id="flip" title="Flip board (F)">${icon('flip')}</button>
          <button class="icon-btn" id="snd" title="Sound">${icon(sound.muted ? 'mute' : 'sound')}</button>
          <span class="spacer"></span>
          <span class="gid">Game ${esc(id)}</span>
          <a href="/fair-play">Fair Play</a>
        </div>
      </div>
    </div>`;

  const panel = el.querySelector('#gp');
  const topBar = el.querySelector('#top');
  const botBar = el.querySelector('#bot');
  const resEl = el.querySelector('#res');

  let g = null;           // latest snapshot from the server, kept in sync
  let chess = new Chess();
  let viewPly = 0;        // which position is on the board
  let clockBase = null;   // { w, b, at } with at = performance.now() at receipt
  let pendingOwn = null;  // a move we sent and the server has not echoed
  let resultClosed = false;
  let lowWarned = false;
  let telemetry = { blur: 0, hidden: 0, hiddenSince: null };
  let raf = 0;
  let serverRef = { now: Date.now(), at: performance.now() };

  const you = () => g?.you || null;
  const active = () => g?.status === 'active';
  const myTurn = () => active() && you() && chess.turn() === you() && viewPly === chess.history().length;

  const board = new Board(el.querySelector('#bd'), {
    canMove: (c) => active() && c === you() && chess.turn() === c && viewPly === chess.history().length,
    canPremove: (c) => active() && c === you() && chess.turn() !== c && viewPly === chess.history().length,
    onMove: (from, to, promotion, meta) => playOwn(from, to, promotion, meta),
  });

  el.querySelector('#flip').onclick = () => { board.flip(); paintBars(); };
  el.querySelector('#snd').onclick = (e) => { sound.toggle(); e.currentTarget.innerHTML = icon(sound.muted ? 'mute' : 'sound'); };

  // ---- focus telemetry (only counted while it's your move) ----
  const onBlur = () => { if (myTurn()) telemetry.blur++; };
  const onVis = () => {
    if (document.hidden) { if (myTurn()) telemetry.hiddenSince = performance.now(); }
    else if (telemetry.hiddenSince) { telemetry.hidden += performance.now() - telemetry.hiddenSince; telemetry.hiddenSince = null; }
  };
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVis);
  const resetTelemetry = () => { telemetry = { blur: 0, hidden: 0, hiddenSince: document.hidden ? performance.now() : null }; };

  // ---- server sync ----
  function load(snap) {
    const firstLoad = !g;
    const wasActive = g?.status === 'active';
    g = snap;
    chess = new Chess();
    for (const m of g.moves) chess.move({ from: m.u.slice(0, 2), to: m.u.slice(2, 4), promotion: m.u[4] });
    pendingOwn = null;
    viewPly = g.moves.length;
    if (firstLoad) board.setOrientation(g.you || 'w');
    board.setPosition(chess.fen(), { lastMove: lastMoveOf(viewPly), animate: !firstLoad });
    setClocks(g.clocks);
    serverRef = { now: g.serverNow, at: performance.now() };
    if (g.status === 'active' && g.you) store.set({ activeGame: g.id });
    if (wasActive && g.status !== 'active') onEnd();
    if (firstLoad && g.status === 'active' && g.moves.length === 0 && g.you) sound.start();
    resetTelemetry();
    paintAll();
  }

  function setClocks(c) { clockBase = { w: c.w, b: c.b, at: performance.now() }; }
  function remaining(color) {
    if (!clockBase) return 0;
    const running = active() && g.running !== false && chess.history().length >= 2 && chess.turn() === color;
    return running ? Math.max(0, clockBase[color] - (performance.now() - clockBase.at)) : clockBase[color];
  }

  function lastMoveOf(ply) {
    if (!ply || !g) return null;
    const m = g.moves[ply - 1];
    return m ? [m.u.slice(0, 2), m.u.slice(2, 4)] : null;
  }

  function playOwn(from, to, promotion, meta = {}) {
    if (!active() || chess.turn() !== you()) return false;
    let mv;
    try { mv = chess.move({ from, to, promotion }); } catch { return false; }
    const u = mv.from + mv.to + (mv.promotion || '');
    const ply = g.moves.length;
    g.moves.push({ u, s: mv.san });
    viewPly = g.moves.length;
    // Freeze our clock at what is left and start theirs.
    const mine = remaining(you());
    clockBase = { ...clockBase, [you()]: mine, at: performance.now() };
    if (g.moves.length >= 2) g.running = true;
    g.drawOffer = g.drawOffer === you() ? you() : null;
    pendingOwn = { u, ply };
    const hidden = telemetry.hidden + (telemetry.hiddenSince ? performance.now() - telemetry.hiddenSince : 0);
    ws.send({ t: 'move', id: g.id, u, ply, blur: telemetry.blur, hidden: Math.round(hidden) });
    resetTelemetry();
    board.setPosition(chess.fen(), { lastMove: [mv.from, mv.to], animate: !!meta.premove });
    sound.forSan(mv.san);
    paintAll();
    return true;
  }

  const offs = [
    bus.on('game', (m) => { if (m.game.id === id) load(m.game); }),
    bus.on('move', (m) => {
      if (!g || m.id !== id) return;
      if (pendingOwn && m.ply === pendingOwn.ply + 1 && m.u === pendingOwn.u) {
        pendingOwn = null;
        setClocks(m.clocks);
        g.firstMoveDeadline = m.firstMoveDeadline;
        serverRef = { now: m.serverNow, at: performance.now() };
        g.running = m.running;
        g.drawOffer = m.drawOffer;
        paintAll();
        return;
      }
      if (m.ply !== g.moves.length + 1) { ws.send({ t: 'sub', id }); return; } // out of step: resync
      let mv;
      try { mv = chess.move({ from: m.u.slice(0, 2), to: m.u.slice(2, 4), promotion: m.u[4] }); }
      catch { ws.send({ t: 'sub', id }); return; }
      g.moves.push({ u: m.u, s: m.s });
      g.running = m.running;
      g.drawOffer = m.drawOffer;
      g.firstMoveDeadline = m.firstMoveDeadline;
      serverRef = { now: m.serverNow, at: performance.now() };
      setClocks(m.clocks);
      const atEnd = viewPly === g.moves.length - 1;
      if (atEnd) {
        viewPly = g.moves.length;
        board.setPosition(chess.fen(), { lastMove: [mv.from, mv.to] });
      }
      sound.forSan(mv.san);
      if (you() && chess.turn() === you()) resetTelemetry();
      paintAll();
    }),
    bus.on('reject', (m) => {
      if (m.id !== id) return;
      toast(m.message, { kind: 'bad', ms: 2500 });
      load(m.game);
    }),
    bus.on('end', (m) => { if (m.id === id) load(m.game); }),
    bus.on('draw', (m) => {
      if (!g || m.id !== id) return;
      g.drawOffer = m.offer;
      if (m.offer && m.offer !== you()) sound.notify();
      paintPanel();
    }),
    bus.on('presence', (m) => { if (g && m.id === id) { g.gone = m.gone; paintBars(); } }),
    bus.on('chat', (m) => {
      if (!g || m.id !== id) return;
      g.chat.push(m.entry);
      if (m.entry.c !== you() && !chatMuted) sound.notify();
      paintChat();
    }),
    bus.on('ws-open', () => ws.send({ t: 'sub', id })),
    bus.on('error', (m) => { if (m.code === 'not_found' || m.code === 'private') notFound(m.message); }),
  ];
  ws.send({ t: 'sub', id });

  function notFound(msg) {
    panel.innerHTML = `<div class="empty">${esc(msg)}</div><a class="btn btn-gray btn-block" href="/">Back to lobby</a>`;
  }

  function onEnd() {
    store.set({ activeGame: null });
    resultClosed = false;
    const r = outcome();
    if (r === 'win') sound.win(); else if (r === 'loss') sound.lose(); else sound.draw();
    refreshMe().catch(() => {});
  }

  function outcome() {
    if (!g || g.status === 'active') return null;
    if (g.status === 'aborted') return 'aborted';
    if (g.result === '1/2-1/2') return 'draw';
    if (!you()) return 'over';
    return (g.result === '1-0') === (you() === 'w') ? 'win' : 'loss';
  }

  // ---- painting ----
  function paintAll() { paintBars(); paintPanel(); paintResult(); }

  function sideInfo(color) {
    const s = color === 'w' ? g.white : g.black;
    // s.bot only appears on old games against the retired house bots.
    return { name: s.name || 'Player', sub: s.bot ? 'Bot' : color === you() ? 'You' : '', av: userAvatar(s.name || '?') };
  }

  function material(color) {
    const counts = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
    const fenBoard = board.chess.board();
    let score = 0;
    fenBoard.forEach((row) => row.forEach((p) => { if (p && p.type !== 'k') { counts[p.color][p.type]++; score += (p.color === 'w' ? 1 : -1) * VALUES[p.type]; } }));
    const opp = color === 'w' ? 'b' : 'w';
    // Pieces this side has taken = opponent's missing pieces.
    let html = '';
    for (const t of ['q', 'r', 'b', 'n', 'p']) {
      const missing = Math.max(0, START[t] - counts[opp][t]);
      for (let i = 0; i < missing; i++) html += `<img src="/pieces/${opp}${t.toUpperCase()}.svg" alt="">`;
    }
    const adv = color === 'w' ? score : -score;
    return html + (adv > 0 ? `<em>+${adv}</em>` : '');
  }

  function paintBars() {
    if (!g) return;
    const bottom = board.orientation;
    const top = bottom === 'w' ? 'b' : 'w';
    for (const [elBar, color] of [[topBar, top], [botBar, bottom]]) {
      const s = sideInfo(color);
      const gone = g.gone?.[color];
      elBar.innerHTML = `
        <div class="who">
          <div class="av">${s.av}</div>
          <div style="min-width:0">
            <div class="name">${esc(s.name)}</div>
            <div class="sub">${gone ? `<span class="gone-note" data-gone="${gone}">Disconnected</span>` : esc(s.sub)}</div>
          </div>
          <div class="material">${material(color)}</div>
        </div>
        <div class="clock num" data-clock="${color}">${clock(remaining(color))}</div>`;
    }
    paintClocks(true);
  }

  function paintClocks(force) {
    if (!g) return;
    for (const c of ['w', 'b']) {
      const elc = el.querySelector(`[data-clock="${c}"]`);
      if (!elc) continue;
      const ms = remaining(c);
      const txt = clock(ms);
      if (force || elc.textContent !== txt) elc.textContent = txt;
      const on = active() && chess.turn() === c && (chess.history().length >= 2 || g.firstMoveDeadline);
      elc.classList.toggle('on', !!on);
      const lowAt = g.tc <= 3 ? 20_000 : g.tc <= 10 ? 30_000 : 60_000;
      elc.classList.toggle('low', ms < lowAt && active());
      if (active() && c === you() && ms < lowAt && !lowWarned && chess.history().length >= 2) { lowWarned = true; sound.low(); }
    }
    for (const s of el.querySelectorAll('[data-gone]')) {
      const left = Math.max(0, +s.dataset.gone - (Date.now()));
      s.textContent = `Disconnected · forfeits in ${Math.ceil(left / 1000)}s`;
    }
    const fm = panel.querySelector('[data-first]');
    if (fm && g.firstMoveDeadline) {
      const left = Math.max(0, g.firstMoveDeadline - serverRef.now - (performance.now() - serverRef.at));
      fm.textContent = Math.ceil(left / 1000);
    }
  }

  const loop = () => { paintClocks(false); raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop);

  function statusLine() {
    if (!g) return '';
    if (!active()) {
      const o = outcome();
      if (o === 'aborted') return reasonText(g.reason);
      const head = g.result === '1/2-1/2' ? 'Draw' : g.result === '1-0' ? 'White won' : 'Black won';
      return `${head} ${reasonText(g.reason)}`;
    }
    const n = chess.history().length;
    if (n < 2 && g.firstMoveDeadline) {
      if (you() && chess.turn() === you()) return `Your first move. The game aborts in <b data-first>30</b>s otherwise.`;
      return 'Waiting for the first move';
    }
    if (!you()) return `${chess.turn() === 'w' ? 'White' : 'Black'} to move`;
    return chess.turn() === you() ? 'Your move' : 'Opponent to move';
  }

  function paintPanel() {
    if (!g) return;
    const isBot = g.kind === 'bot'; // an old game against a retired house bot
    const n = g.moves.length;
    const mine = you();
    let actions = '';
    if (active() && mine) {
      const canAbort = n < 2;
      actions = `
        <div class="act-row">
          ${canAbort
            ? `<button class="btn btn-gray" data-a="abort">${icon('x')}Abort</button>`
            : `<button class="btn btn-gray" data-a="draw" ${g.drawOffer === mine ? 'disabled' : ''}>${icon('hand')}${g.drawOffer === mine ? 'Offered' : 'Offer draw'}</button>`}
          <button class="btn btn-gray" data-a="resign" ${canAbort ? 'disabled' : ''}>${icon('flag')}Resign</button>
        </div>`;
    } else if (!active()) {
      actions = `<div class="act-row">${again()}<a class="btn btn-gray" href="/">Lobby</a></div>`;
    }
    const offer = active() && mine && g.drawOffer && g.drawOffer !== mine
      ? `<div class="offer"><span>Your opponent offers a draw</span><button class="btn btn-green btn-sm" data-a="accept">Accept</button><button class="btn btn-gray btn-sm" data-a="decline">Decline</button></div>` : '';

    // The panel has a part that repaints on every move and a chat block that
    // is built once, so a half-typed message survives incoming moves.
    if (!panel.querySelector('#gpMain')) panel.innerHTML = '<div id="gpMain" style="display:flex;flex-direction:column;flex:1;min-height:0"></div><div id="gpChat"></div>';
    const main = panel.querySelector('#gpMain');
    if (!isBot && mine) buildChat();
    main.innerHTML = `
      <div class="gp-head">
        <span class="t">${icon(isBot ? 'bot' : 'users')}${isBot ? 'House bot' : 'Human'} · ${g.tc} min</span>
        <span class="dim" style="font-weight:600;font-size:12.5px">${active() ? 'Live' : 'Finished'}</span>
      </div>
      <div class="gp-pot">
        <div class="box"><span>Wager</span><b>${money(g.stake)}</b></div>
        <div class="box"><span>${isBot ? 'Win pays' : 'Win pays (after rake)'}</span><b class="green">${money(g.payouts.win)}</b></div>
      </div>
      <div class="muted" style="font-weight:600;margin:0 2px 10px;min-height:20px" id="status">${statusLine()}</div>
      ${offer}
      <div class="moves" id="moves">${moveList()}</div>
      <div class="nav-row">
        <button class="btn btn-gray" data-nav="first" title="First">${icon('first')}</button>
        <button class="btn btn-gray" data-nav="prev" title="Previous (←)">${icon('prev')}</button>
        <button class="btn btn-gray" data-nav="next" title="Next (→)">${icon('next')}</button>
        <button class="btn btn-gray" data-nav="last" title="Latest">${icon('last')}</button>
      </div>
      ${actions}`;

    main.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => action(b.dataset.a)));
    main.querySelectorAll('[data-nav]').forEach((b) => (b.onclick = () => nav(b.dataset.nav)));
    main.querySelectorAll('[data-ply]').forEach((b) => (b.onclick = () => goto(+b.dataset.ply)));
    const mv = main.querySelector('#moves');
    const cur = mv.querySelector('.cur');
    if (cur) cur.scrollIntoView({ block: 'nearest' }); else mv.scrollTop = mv.scrollHeight;
  }

  let chatMuted = false;
  function buildChat() {
    const box = panel.querySelector('#gpChat');
    if (!box || box.dataset.ready) return;
    box.dataset.ready = '1';
    box.innerHTML = `
      <div class="chat">
        <div class="chat-head"><span>Chat</span><button class="chat-mute" type="button" title="Hide your opponent's messages">Mute opponent</button></div>
        <div class="chat-log" id="chat" aria-live="polite"></div>
        <form class="chat-form" autocomplete="off">
          <input class="input" maxlength="200" placeholder="Send a message" aria-label="Message">
          <button class="btn btn-blue btn-sm" type="submit">Send</button>
        </form>
        <div class="chat-presets">${(store.config.chat || []).map((t, i) => `<button type="button" data-chat="${i}">${esc(t)}</button>`).join('')}</div>
      </div>`;
    const input = box.querySelector('input');
    box.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || !g) return;
      ws.send({ t: 'chat', id: g.id, text });
      input.value = '';
    };
    box.querySelectorAll('[data-chat]').forEach((b) => (b.onclick = () => ws.send({ t: 'chat', id: g.id, k: +b.dataset.chat })));
    box.querySelector('.chat-mute').onclick = (e) => {
      chatMuted = !chatMuted;
      e.currentTarget.textContent = chatMuted ? 'Unmute opponent' : 'Mute opponent';
      paintChat();
    };
    paintChat();
  }

  function again() {
    if (g.kind === 'bot') return '<a class="btn btn-green" href="/play">Play a human</a>';
    return `<a class="btn btn-green" href="/play?tc=${g.tc}&stake=${g.stake}&go=1">New game</a>`;
  }

  function moveList() {
    if (!g.moves.length) return '<div class="empty">No moves yet</div>';
    let html = '';
    for (let i = 0; i < g.moves.length; i += 2) {
      const a = g.moves[i], b = g.moves[i + 1];
      html += `<div class="row"><span class="n">${i / 2 + 1}.</span>
        <button data-ply="${i + 1}" class="${viewPly === i + 1 ? 'cur' : ''}">${esc(a.s)}</button>
        ${b ? `<button data-ply="${i + 2}" class="${viewPly === i + 2 ? 'cur' : ''}">${esc(b.s)}</button>` : '<span></span>'}</div>`;
    }
    return html;
  }

  function paintChat() {
    const c = panel.querySelector('#chat');
    if (!c || !g) return;
    const shown = g.chat.filter((m) => !(chatMuted && m.c !== you()));
    const hidden = g.chat.length - shown.length;
    c.innerHTML = shown.length
      ? shown.map((m) => {
          const me = m.c === you();
          return `<div class="cm ${me ? 'me' : 'opp'}"><span class="who">${me ? 'You' : 'Opponent'}</span>${esc(m.text)}</div>`;
        }).join('') + (hidden ? `<div class="dim cm-note">${hidden} hidden</div>` : '')
      : `<div class="dim cm-note">${hidden ? `${hidden} hidden` : 'Say hi to your opponent.'}</div>`;
    c.scrollTop = c.scrollHeight;
  }

  function paintResult() {
    if (!g || active() || resultClosed) { resEl.innerHTML = ''; return; }
    const o = outcome();
    const mine = you();
    const paid = mine ? g.settlement?.[mine] ?? 0 : 0;
    const titles = { win: 'You won', loss: 'You lost', draw: 'Draw', aborted: 'Game aborted', over: g.result === '1/2-1/2' ? 'Draw' : g.result === '1-0' ? 'White won' : 'Black won' };
    let amount = '', sub = '';
    if (mine) {
      if (o === 'win') { amount = `<div class="amount green">${money(paid - g.stake, { sign: true })}</div>`; sub = `${money(paid)} paid out${g.kind === 'human' && g.settlement?.rake ? ` · ${money(g.settlement.rake)} rake` : ''}`; }
      if (o === 'loss') { amount = `<div class="amount">${money(-g.stake)}</div>`; sub = 'Wager lost'; }
      if (o === 'draw') { amount = `<div class="amount">${money(paid)}</div>`; sub = g.kind === 'human' ? `returned · ${money(g.stake - paid)} rake` : 'Wager returned'; }
      if (o === 'aborted') { amount = `<div class="amount">${money(g.stake)}</div>`; sub = 'Wager returned in full'; }
      if (g.reason === 'fair-play' && o === 'win') sub = 'Your opponent was removed for fair play. You receive the whole pot.';
    }
    resEl.innerHTML = `
      <div class="result ${o === 'win' ? 'win' : ''}">
        <button class="icon-btn x" aria-label="Close">${icon('x')}</button>
        <h3>${titles[o]}</h3>
        <div class="why">${o === 'aborted' ? esc(reasonText(g.reason)) : esc(reasonText(g.reason))}</div>
        ${amount}<div class="amount-sub">${esc(sub)}</div>
        <div class="actions">${mine ? again() : ''}<a class="btn btn-gray" href="/">Back to lobby</a></div>
      </div>`;
    resEl.querySelector('.x').onclick = () => { resultClosed = true; paintResult(); };
  }

  // ---- actions ----
  async function action(a) {
    if (a === 'resign') {
      if (await confirmBox('Resign this game?', `You will lose your ${money(g.stake)} wager.`, { ok: 'Resign', danger: true })) ws.send({ t: 'resign', id: g.id });
    }
    if (a === 'abort') ws.send({ t: 'abort', id: g.id });
    if (a === 'draw') { ws.send({ t: 'draw-offer', id: g.id }); g.drawOffer = you(); paintPanel(); }
    if (a === 'accept') ws.send({ t: 'draw-accept', id: g.id });
    if (a === 'decline') { ws.send({ t: 'draw-decline', id: g.id }); g.drawOffer = null; paintPanel(); }
  }

  function goto(ply) {
    if (!g) return;
    viewPly = Math.max(0, Math.min(g.moves.length, ply));
    const c = new Chess();
    for (const m of g.moves.slice(0, viewPly)) c.move({ from: m.u.slice(0, 2), to: m.u.slice(2, 4), promotion: m.u[4] });
    board.setPosition(c.fen(), { lastMove: lastMoveOf(viewPly) });
    paintPanel();
    paintBars();
  }
  function nav(d) {
    if (!g) return;
    if (d === 'first') goto(0);
    if (d === 'prev') goto(viewPly - 1);
    if (d === 'next') goto(viewPly + 1);
    if (d === 'last') goto(g.moves.length);
  }
  const onKey = (e) => {
    if (e.target.closest('input, textarea')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); nav('prev'); }
    if (e.key === 'ArrowRight') { e.preventDefault(); nav('next'); }
    if (e.key === 'ArrowUp' || e.key === 'Home') { e.preventDefault(); nav('first'); }
    if (e.key === 'ArrowDown' || e.key === 'End') { e.preventDefault(); nav('last'); }
    if (e.key === 'f' && !e.metaKey && !e.ctrlKey) { board.flip(); paintBars(); }
  };
  document.addEventListener('keydown', onKey);

  // Leaving mid-game is allowed (the clock keeps running), but warn on unload.
  const beforeUnload = (e) => { if (active() && you()) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);

  return () => {
    offs.forEach((f) => f());
    cancelAnimationFrame(raf);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVis);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', beforeUnload);
    board.destroy();
  };
}

import { esc, money, icon } from '../lib.js';
import { store, bus, ws } from '../store.js';
import { Board } from '../board.js';
import { sound } from '../sound.js';
import { requireUser } from './auth.js';
import { openWallet } from './wallet.js';
import { navigate } from '../app.js';

let last = { tc: 10, stake: 500 };
try { Object.assign(last, JSON.parse(localStorage.getItem('cb-queue') || '{}')); } catch {}

export default function play(el, _params, query) {
  const cfg = store.config;
  const sel = {
    tc: [3, 10].includes(+query.get('tc')) ? +query.get('tc') : last.tc,
    stake: [100, 500, 1000].includes(+query.get('stake')) ? +query.get('stake') : last.stake,
  };
  const key = () => `${sel.tc}:${sel.stake}`;
  const q = () => cfg.queues.find((x) => x.key === key());

  el.innerHTML = `
    <div class="stage">
      <div class="panel" id="pp"></div>
      <div class="arena">
        <div class="arena-main"><div class="board-wrap" style="position:relative"><div id="pv"></div><div id="over"></div></div></div>
        <div class="stage-foot">
          <button class="icon-btn" id="snd" title="Sound">${icon(sound.muted ? 'mute' : 'sound')}</button>
          <span class="spacer"></span>
          <a href="/fair-play">Fair Play</a><a href="/terms">Rules</a>
        </div>
      </div>
    </div>`;

  const board = new Board(el.querySelector('#pv'), { orientation: 'w' });
  board.viewOnly = true;
  const panel = el.querySelector('#pp');
  const over = el.querySelector('#over');
  el.querySelector('#snd').onclick = (e) => { sound.toggle(); e.currentTarget.innerHTML = icon(sound.muted ? 'mute' : 'sound'); };

  let timer = null;

  function paint() {
    const u = store.user;
    const inQ = store.queue;
    const searching = inQ && inQ.key === key();
    const lockSel = !!inQ;
    const info = q();
    let action;
    if (store.activeGame) action = `<a class="btn btn-green btn-lg" href="/game/${esc(store.activeGame)}">Return to your game</a>`;
    else if (!u) action = `<button class="btn btn-green btn-lg" data-act="login">Sign in to play</button>`;
    else if (u.status !== 'active') action = `<button class="btn btn-gray btn-lg" disabled>Account suspended</button>`;
    else if (searching) action = `<button class="btn btn-gray btn-lg" data-act="cancel">Cancel search</button>`;
    else if (u.balance + (inQ ? inQ.stake : 0) < sel.stake) action = `<button class="btn btn-green btn-lg" data-act="deposit">Deposit to play</button>`;
    else action = `<button class="btn btn-green btn-lg" data-act="join">Find opponent</button>`;

    panel.innerHTML = `
      <div class="seg">
        <button data-tc="3" class="${sel.tc === 3 ? 'on' : ''}" ${lockSel ? 'disabled' : ''}>3 min</button>
        <button data-tc="10" class="${sel.tc === 10 ? 'on' : ''}" ${lockSel ? 'disabled' : ''}>10 min</button>
      </div>
      <div class="field">
        <div class="field-label">Wager <span class="aside num">${u ? `Balance ${money(u.balance)}` : ''}</span></div>
        <div class="chips">${[100, 500, 1000].map((s) => `<button class="chip ${sel.stake === s ? 'on' : ''}" data-stake="${s}" ${lockSel ? 'disabled' : ''}>${money(s).replace('.00', '')}</button>`).join('')}</div>
      </div>
      <div class="field">
        <div class="field-label">Profit on win</div>
        <div class="readout num"><span class="green">${money(info.win - info.stake)}</span><span class="unit">${money(info.win)} back</span></div>
      </div>
      <div class="field">
        <div class="field-label">On a draw</div>
        <div class="readout num"><span>${money(info.draw)}</span><span class="unit">returned</span></div>
      </div>
      ${action}
      <div class="qlist">
        <h4>All queues</h4>
        ${cfg.queues.map((x) => {
          const n = store.counts?.[x.key] || 0;
          return `<button class="qrow ${x.key === key() ? 'on' : ''}" data-key="${x.key}" ${lockSel ? 'disabled' : ''}>
            <span>${icon(x.tc === 3 ? 'bolt' : 'clock', 'style="width:14px;height:14px;vertical-align:-2px;margin-right:6px"')}${x.tc} min · ${money(x.stake).replace('.00', '')}</span>
            <span class="waiting ${n ? 'some' : ''}"><i></i>${n} waiting</span></button>`;
        }).join('')}
      </div>
      <p class="panel-note">No ratings. You are paired at random with someone else in the same queue. A ${cfg.rakeBps / 100}% rake comes out of the pot on every game that gets played, draws included. Games aborted before both players move are refunded in full. <a href="/fair-play">Fair Play rules</a> apply.</p>`;

    panel.querySelectorAll('[data-tc]').forEach((b) => (b.onclick = () => { sel.tc = +b.dataset.tc; remember(); paint(); }));
    panel.querySelectorAll('[data-stake]').forEach((b) => (b.onclick = () => { sel.stake = +b.dataset.stake; remember(); paint(); }));
    panel.querySelectorAll('[data-key]').forEach((b) => (b.onclick = () => { const [t, s] = b.dataset.key.split(':'); sel.tc = +t; sel.stake = +s; remember(); paint(); }));
    panel.querySelector('[data-act]')?.addEventListener('click', (e) => act(e.currentTarget.dataset.act));
    paintOverlay();
  }

  function paintOverlay() {
    clearInterval(timer);
    const inQ = store.queue;
    if (!inQ) { over.innerHTML = ''; return; }
    const others = Math.max(0, (store.counts?.[inQ.key] || 1) - 1);
    over.innerHTML = `
      <div class="board-dim" style="border-radius:4px"></div>
      <div class="search-card">
        <div class="pulse"></div>
        <h3>Finding an opponent</h3>
        <div class="muted">${inQ.tc} min · ${money(inQ.stake)} wager</div>
        <div class="t"><span id="el">0:00</span> · ${others ? `${others} other${others > 1 ? 's' : ''} waiting` : 'You are first in line'}</div>
      </div>`;
    const elT = over.querySelector('#el');
    const upd = () => {
      const s = Math.max(0, Math.floor((Date.now() - inQ.joinedAt) / 1000));
      elT.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    upd();
    timer = setInterval(upd, 1000);
  }

  function remember() {
    last = { ...sel };
    try { localStorage.setItem('cb-queue', JSON.stringify(last)); } catch {}
    history.replaceState({}, '', `/play?tc=${sel.tc}&stake=${sel.stake}`);
  }

  function act(a) {
    if (a === 'login') return requireUser(() => paint());
    if (a === 'deposit') return openWallet('deposit');
    if (a === 'cancel') return ws.send({ t: 'queue-leave' });
    if (a === 'join') {
      if (!requireUser(() => paint())) return;
      ws.send({ t: 'queue-join', tc: sel.tc, stake: sel.stake });
      const btn = panel.querySelector('[data-act=join]');
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
    }
  }

  const offs = [
    bus.on('store', (p) => { if ('queue' in p || 'user' in p || 'counts' in p || 'activeGame' in p) paint(); }),
    bus.on('queue', (m) => { if (m.state === 'left' && m.why === 'disconnected') paint(); }),
    bus.on('error', (m) => { if (m.code) paint(); }),
  ];
  paint();

  if (query.get('go') === '1' && store.user && !store.queue && !store.activeGame) {
    history.replaceState({}, '', `/play?tc=${sel.tc}&stake=${sel.stake}`);
    if (store.user.balance >= sel.stake) act('join');
    else openWallet('deposit');
  }
  if (store.activeGame && query.get('go') === '1') navigate(`/game/${store.activeGame}`);

  return () => { offs.forEach((f) => f()); clearInterval(timer); board.destroy(); };
}

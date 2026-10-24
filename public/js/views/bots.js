import { api, esc, money, icon, toast } from '../lib.js';
import { store, bus } from '../store.js';
import { botAvatar } from '../avatars.js';
import { sound } from '../sound.js';
import { requireUser } from './auth.js';
import { openWallet } from './wallet.js';
import { navigate } from '../app.js';

let mem = { bot: 'hikaru', stake: 500, color: 'r' };
try { Object.assign(mem, JSON.parse(localStorage.getItem('cb-bot') || '{}')); } catch {}

export default function bots(el, [botParam]) {
  const cfg = store.config;
  const list = cfg.bots;
  if (botParam && list.some((b) => b.id === botParam)) mem.bot = botParam;
  const limits = cfg.bot;
  let amountText = (mem.stake / 100).toFixed(2);

  el.innerHTML = `
    <div class="stage">
      <div class="panel" id="bp"></div>
      <div class="arena">
        <div class="arena-main" id="hero"></div>
        <div class="stage-foot">
          <button class="icon-btn" id="snd" title="Sound">${icon(sound.muted ? 'mute' : 'sound')}</button>
          <span class="spacer"></span>
          <a href="/fair-play">Fair Play</a><a href="/terms">Rules</a>
        </div>
      </div>
    </div>`;
  el.querySelector('#snd').onclick = (e) => { sound.toggle(); e.currentTarget.innerHTML = icon(sound.muted ? 'mute' : 'sound'); };
  const panel = el.querySelector('#bp');
  const hero = el.querySelector('#hero');

  const stakeCents = () => {
    const n = Number(String(amountText).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  };
  const save = () => { try { localStorage.setItem('cb-bot', JSON.stringify(mem)); } catch {} };

  function paintHero() {
    const b = list.find((x) => x.id === mem.bot);
    hero.innerHTML = `
      <div class="bot-hero view-enter">
        <div class="portrait">${botAvatar(b.id)}</div>
        <div><h2>${esc(b.name)}</h2><div class="style">${esc(b.style)}</div></div>
        <p>${esc(b.blurb)}</p>
        <div class="facts">
          <div><b>${limits.minutes} min</b><span>Each side</span></div>
          <div><b>2x</b><span>Paid on a win</span></div>
          <div><b>${money(limits.min).replace('.00', '')}-${money(limits.max).replace('.00', '')}</b><span>Wager</span></div>
        </div>
        <p class="fine">A bot built to play in the style of ${esc(b.fullName)}. Not affiliated with or endorsed by ${esc(b.fullName.split(' ')[0])}.</p>
      </div>`;
  }

  function paint() {
    const u = store.user;
    const stake = stakeCents();
    const valid = stake >= limits.min && stake <= limits.max;
    const b = list.find((x) => x.id === mem.bot);
    let action;
    if (store.activeGame) action = `<a class="btn btn-green btn-lg" href="/game/${esc(store.activeGame)}">Return to your game</a>`;
    else if (!u) action = `<button class="btn btn-green btn-lg" data-act="login">Sign in to play</button>`;
    else if (u.status !== 'active') action = `<button class="btn btn-gray btn-lg" disabled>Account suspended</button>`;
    else if (valid && u.balance < stake) action = `<button class="btn btn-green btn-lg" data-act="deposit">Deposit to play</button>`;
    else action = `<button class="btn btn-green btn-lg" data-act="play" ${valid ? '' : 'disabled'}>Play ${esc(b.name)}</button>`;

    panel.innerHTML = `
      <div class="field-label" style="margin-bottom:8px">Opponent</div>
      <div class="bot-pick">
        ${list.map((x) => `
          <button class="bot-opt ${x.id === mem.bot ? 'on' : ''}" data-bot="${x.id}">
            <div class="av">${botAvatar(x.id)}</div>
            <div><b>${esc(x.name)}</b><span>${esc(x.style)}</span></div>
          </button>`).join('')}
      </div>
      <div class="field">
        <label class="field-label" for="bamt">Wager <span class="aside num">${u ? `Balance ${money(u.balance)}` : ''}</span></label>
        <div class="input-wrap">
          <span class="input-suffix">$</span>
          <input class="input num" id="bamt" inputmode="decimal" value="${esc(amountText)}">
          <div class="input-sep"></div><button class="input-btn" data-mul="0.5">½</button>
          <div class="input-sep"></div><button class="input-btn" data-mul="2">2×</button>
        </div>
      </div>
      <div class="field">
        <div class="field-label">Play as</div>
        <div class="color-pick">
          <button data-color="w" class="${mem.color === 'w' ? 'on' : ''}" title="White"><img src="/pieces/wK.svg" alt="White"></button>
          <button data-color="r" class="${mem.color === 'r' ? 'on' : ''}" title="Random"><span class="half"><img src="/pieces/wK.svg" alt=""><img src="/pieces/bK.svg" alt=""></span></button>
          <button data-color="b" class="${mem.color === 'b' ? 'on' : ''}" title="Black"><img src="/pieces/bK.svg" alt="Black"></button>
        </div>
      </div>
      <div class="field">
        <div class="field-label">Profit on win</div>
        <div class="readout num"><span class="green" id="profit">${money(valid ? stake : 0)}</span><span class="unit">${limits.minutes} min game</span></div>
      </div>
      <div class="form-error" id="berr">${!valid && amountText !== '' ? `Wager between ${money(limits.min)} and ${money(limits.max)}` : ''}</div>
      ${action}
      <p class="panel-note">You play against the house. Win and you are paid double your wager; a draw returns it; a loss keeps it. No rake on bot games. <a href="/fair-play">Fair Play rules</a> apply to bot games too.</p>`;

    panel.querySelectorAll('[data-bot]').forEach((x) => (x.onclick = () => {
      mem.bot = x.dataset.bot; save();
      history.replaceState({}, '', `/bots/${mem.bot}`);
      paint(); paintHero();
    }));
    panel.querySelectorAll('[data-color]').forEach((x) => (x.onclick = () => { mem.color = x.dataset.color; save(); paint(); }));
    const input = panel.querySelector('#bamt');
    input.oninput = () => {
      amountText = input.value;
      const s = stakeCents();
      const ok = s >= limits.min && s <= limits.max;
      panel.querySelector('#profit').textContent = money(ok ? s : 0);
      panel.querySelector('#berr').textContent = ok || input.value === '' ? '' : `Wager between ${money(limits.min)} and ${money(limits.max)}`;
      const btn = panel.querySelector('[data-act=play]');
      if (btn) btn.disabled = !ok;
      if (ok) { mem.stake = s; save(); }
    };
    // Tidy the number on blur without re-rendering, so a click on Play that
    // caused the blur still lands.
    input.onblur = () => {
      if (stakeCents() < limits.min) return;
      amountText = (Math.min(limits.max, stakeCents()) / 100).toFixed(2);
      input.value = amountText;
      input.oninput();
    };
    panel.querySelectorAll('[data-mul]').forEach((x) => (x.onclick = () => {
      const next = Math.min(limits.max, Math.max(limits.min, Math.round(stakeCents() * Number(x.dataset.mul))));
      amountText = (next / 100).toFixed(2);
      mem.stake = next; save();
      paint();
    }));
    panel.querySelector('[data-act]')?.addEventListener('click', (e) => act(e.currentTarget));
  }

  async function act(btn) {
    const a = btn.dataset.act;
    if (a === 'login') return requireUser(() => paint());
    if (a === 'deposit') return openWallet('deposit');
    if (a !== 'play') return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      const r = await api('/api/bots/play', { bot: mem.bot, stake: stakeCents(), color: mem.color === 'r' ? null : mem.color });
      store.set({ activeGame: r.id });
      sound.start();
      navigate(`/game/${r.id}`);
    } catch (e) {
      toast(e.message, { kind: 'bad' });
      if (e.data?.game) store.set({ activeGame: e.data.game });
      paint();
    }
  }

  const off = bus.on('store', (p) => { if ('user' in p || 'activeGame' in p) paint(); });
  paint();
  paintHero();
  return () => off();
}

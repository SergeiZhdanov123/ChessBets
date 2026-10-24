// Small shared helpers: escaping, money, fetch, toasts, modals, icons.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const money = (cents, { sign = false } = {}) => {
  const v = Math.abs(Math.round(cents || 0));
  const s = `$${Math.floor(v / 100).toLocaleString('en-US')}.${String(v % 100).padStart(2, '0')}`;
  if (cents < 0) return `-${s}`;
  return sign && cents > 0 ? `+${s}` : s;
};

export const clock = (ms) => {
  ms = Math.max(0, ms);
  if (ms < 10_000) {
    const s = Math.floor(ms / 1000);
    return `0:0${s}.${Math.floor((ms % 1000) / 100)}`;
  }
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

export const ago = (t) => {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export const dateTime = (t) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export async function api(path, body, method) {
  const opts = { method: method || (body === undefined ? 'GET' : 'POST'), headers: { 'x-cb': '1' }, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, opts); }
  catch { throw Object.assign(new Error('Network error. Check your connection.'), { status: 0 }); }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

// ---- toasts ----
export function toast(title, { body = '', kind = 'info', ms = 4200 } = {}) {
  const root = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="tt">${esc(title)}${body ? `<span>${esc(body)}</span>` : ''}</div><button class="icon-btn" aria-label="Dismiss" style="width:24px;height:24px">${icon('x')}</button>`;
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  el.querySelector('button').onclick = close;
  root.prepend(el);
  while (root.children.length > 4) root.lastChild.remove();
  if (ms) setTimeout(close, ms);
  return close;
}

// ---- modal ----
let modalClose = null;
export function openModal({ title, iconName, body, foot, width, onClose }) {
  closeModal();
  const root = document.getElementById('modal');
  root.innerHTML = `
    <div class="modal-root">
      <div class="modal-back"></div>
      <div class="modal" role="dialog" aria-modal="true" ${width ? `style="width:min(${width}px,100%)"` : ''}>
        <div class="modal-head"><h3>${iconName ? icon(iconName) : ''}${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
        <div class="modal-body"></div>
        ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
      </div>
    </div>`;
  const bodyEl = root.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
  const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
  root.querySelector('.modal-back').onclick = closeModal;
  root.querySelector('[data-close]').onclick = closeModal;
  document.addEventListener('keydown', onKey);
  modalClose = () => { document.removeEventListener('keydown', onKey); root.innerHTML = ''; onClose?.(); };
  return { root, body: bodyEl, head: root.querySelector('.modal-head h3') };
}
export function closeModal() { const f = modalClose; modalClose = null; f?.(); }
export const modalOpen = () => !!modalClose;

export function confirmBox(title, text, { ok = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal({
      title, width: 400,
      body: `<p class="muted" style="margin-bottom:18px;font-weight:500">${esc(text)}</p>
             <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><button class="btn btn-gray" data-no>Cancel</button><button class="btn ${danger ? 'btn-red' : 'btn-green'}" data-yes>${esc(ok)}</button></div>`,
      onClose: () => { if (!done) resolve(false); },
    });
    m.body.querySelector('[data-no]').onclick = () => closeModal();
    m.body.querySelector('[data-yes]').onclick = () => { done = true; resolve(true); closeModal(); };
  });
}

// ---- tiny event bus ----
export function emitter() {
  const map = new Map();
  return {
    on(ev, fn) { if (!map.has(ev)) map.set(ev, new Set()); map.get(ev).add(fn); return () => map.get(ev).delete(fn); },
    emit(ev, data) { for (const fn of map.get(ev) || []) fn(data); },
  };
}

// ---- icons (24px grid, stroke) ----
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h5v-6h4v6h5V9.5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18.5 14.8c1.7.8 2.8 2.5 3 5.2"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4"/><circle cx="12" cy="3.5" r="1"/><circle cx="9" cy="14" r="1.3" fill="currentColor"/><circle cx="15" cy="14" r="1.3" fill="currentColor"/><path d="M2 13v3M22 13v3"/>',
  wallet: '<path d="M19 7V5.5A1.5 1.5 0 0 0 17.5 4h-12A2.5 2.5 0 0 0 3 6.5v11A2.5 2.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/><path d="M3 6.5A2.5 2.5 0 0 0 5.5 9H20a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-3.5a2.5 2.5 0 0 1 0-5"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6Z"/><path d="m9 12 2 2 4-4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.3a2.6 2.6 0 0 1 5 .9c0 1.8-2.5 2.3-2.5 3.8"/><circle cx="12" cy="17.2" r=".6" fill="currentColor"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  bolt: '<path d="M13 2 4.5 13.5H12L11 22l8.5-11.5H12Z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  hand: '<path d="M7 11.5V6.5a1.5 1.5 0 0 1 3 0v4"/><path d="M10 10V4.5a1.5 1.5 0 0 1 3 0V10"/><path d="M13 10V5.5a1.5 1.5 0 0 1 3 0V12"/><path d="M16 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5a6.5 6.5 0 0 1-5.4-2.9L3.4 14a1.6 1.6 0 0 1 2.5-2l1.1 1.3"/>',
  flip: '<path d="M7 4v16M7 20l-3-3M7 20l3-3"/><path d="M17 20V4M17 4l-3 3M17 4l3 3"/>',
  sound: '<path d="M4 9.5v5h3.5L12 19V5L7.5 9.5Z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5v5h3.5L12 19V5L7.5 9.5Z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
  first: '<path d="M18 6 12 12l6 6M7 6v12"/>',
  prev: '<path d="M15 6 9 12l6 6"/>',
  next: '<path d="m9 6 6 6-6 6"/>',
  last: '<path d="m6 6 6 6-6 6M17 6v12"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4 4-6.5 8-6.5s7.2 2.5 8 6.5"/>',
  admin: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6Z"/><circle cx="12" cy="10.5" r="2.5"/><path d="M8 16.5c.8-1.6 2.2-2.5 4-2.5s3.2.9 4 2.5"/>',
  alert: '<path d="M12 3 2 20h20Z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.3" r=".6" fill="currentColor"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  arrowDown: '<path d="M12 4v15M6 13l6 6 6-6"/>',
  arrowUp: '<path d="M12 20V5M6 11l6-6 6 6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1" fill="currentColor"/><circle cx="3.5" cy="12" r="1" fill="currentColor"/><circle cx="3.5" cy="18" r="1" fill="currentColor"/>',
  trophy: '<path d="M7 4h10v5a5 5 0 0 1-10 0Z"/><path d="M7 6H4v1.5A3.5 3.5 0 0 0 7.5 11M17 6h3v1.5a3.5 3.5 0 0 1-3.5 3.5"/><path d="M12 14v3M8 21h8M9.5 17h5l.5 4h-6Z"/>',
  play: '<path d="M7 4.5v15l12.5-7.5Z"/>',
  chat: '<path d="M4 5h16v11H9l-5 4Z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
};
export const icon = (name, attrs = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${attrs}>${P[name] || ''}</svg>`;

export const knightMark = `<svg viewBox="0 0 32 32" aria-hidden="true"><path fill="#00e701" d="M9 27h13.5l-.9-3.4c2.7-2.6 3.7-5.7 3.7-8.9 0-5-3.8-8.2-8.9-8.2L15 4.8l-1.1 2.4C10.8 8.3 9.2 10.5 8.3 12.8L5 16.3l1.7 2.3 3.6-1c1-.3 2-.1 2.6.4-2 2.4-3.8 5.3-3.9 9Z"/></svg>`;

// Coin glyphs: flat discs with a letter, not brand marks.
const COIN_COLORS = { BTC: '#f7931a', ETH: '#7b8cde', USDT: '#26a17b', USDC: '#2775ca', SOL: '#9b6dff', LTC: '#a6a9aa', DOGE: '#c2a633' };
export const coinIcon = (code) =>
  `<svg class="ci" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="${COIN_COLORS[code] || '#557086'}"/><text x="10" y="13.6" text-anchor="middle" font-size="${code.length > 3 ? 6.4 : 8}" font-weight="800" fill="#fff" font-family="Figtree, sans-serif">${code === 'BTC' ? '₿' : code === 'ETH' ? 'Ξ' : code[0]}</text></svg>`;

export const reasonText = (r, result, you) => ({
  checkmate: 'by checkmate', resign: 'by resignation', timeout: 'on time', 'timeout-draw': 'timeout vs insufficient material',
  stalemate: 'by stalemate', repetition: 'by threefold repetition', insufficient: 'by insufficient material', 'fifty-moves': 'by the 50-move rule',
  agreement: 'by agreement', abandoned: 'by abandonment', 'fair-play': 'by fair-play decision', aborted: 'Game aborted',
  'no-first-move': 'No first move in time', 'abandoned-early': 'Player left before the game started', 'server-restart': 'Server restarted',
})[r] || r || '';

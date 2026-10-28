import { esc, money, icon, knightMark, coinIcon, toast, closeModal, api } from './lib.js';
import { store, bus, ws, connect, loadConfig, refreshMe } from './store.js';
import { sound } from './sound.js';
import { openAuth } from './views/auth.js';
import { openWallet } from './views/wallet.js';
import { track } from './track.js';

const routes = [
  [/^\/$/, () => import('./views/home.js')],
  [/^\/play$/, () => import('./views/play.js')],
  [/^\/game\/([\w-]+)$/, () => import('./views/game.js')],
  [/^\/games$/, () => import('./views/history.js')],
  [/^\/(fair-play|terms|privacy|legal)$/, () => import('./views/pages.js')],
  [/^\/support$/, () => import('./views/support.js')],
  [/^\/admin\/analytics$/, () => import('./views/analytics.js')],
  [/^\/admin(?:\/(\d+))?$/, () => import('./views/admin.js')],
];

const view = document.getElementById('view');
let cleanup = null;
let navToken = 0;

export function navigate(path, { replace = false } = {}) {
  if (path === location.pathname + location.search && !replace) return render();
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  render();
}
window.addEventListener('popstate', () => render());

async function render() {
  const token = ++navToken;
  const path = location.pathname;
  closeModal();
  document.getElementById('shell').classList.remove('side-open');

  // Modal routes sit on top of the lobby.
  let modal = null;
  let target = path;
  if (path === '/wallet' || path === '/login' || path === '/register') { modal = path.slice(1); target = '/'; }

  const match = routes.find(([re]) => re.test(target));
  const mod = match ? await match[1]() : null;
  if (token !== navToken) return;
  cleanup?.();
  cleanup = null;
  view.className = 'page view-enter';
  view.innerHTML = '';
  window.scrollTo({ top: 0 });
  if (!mod) {
    view.innerHTML = `<div class="empty" style="padding:80px 0"><h2 style="color:#fff;margin-bottom:8px">Page not found</h2><a class="btn btn-gray" href="/">Back to lobby</a></div>`;
  } else {
    const params = target.match(match[0]).slice(1);
    const out = mod.default(view, params, new URLSearchParams(location.search));
    cleanup = typeof out === 'function' ? out : null;
  }
  renderSidebar();
  renderMobileNav();
  track('view');
  if (modal === 'wallet') store.user ? openWallet() : openAuth('login');
  if (modal === 'login' || modal === 'register') openAuth(modal);
}

// Intercept internal links.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || a.target || a.hasAttribute('download') || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const href = a.getAttribute('href');
  if (!href.startsWith('/') || href.startsWith('//')) return;
  e.preventDefault();
  navigate(href);
});

// ---- shell ----
const shell = document.getElementById('shell');
try { if (localStorage.getItem('cb-collapsed') === '1') shell.classList.add('collapsed'); } catch {}

function navLink(href, ic, label, extra = '') {
  const here = location.pathname;
  const on = href === '/' ? here === '/' : here.startsWith(href);
  return `<a class="side-link ${on ? 'on' : ''}" href="${href}" title="${esc(label)}">${icon(ic)}<span>${esc(label)}</span>${extra}</a>`;
}

function renderSidebar() {
  const u = store.user;
  const el = document.getElementById('sidebar');
  el.innerHTML = `
    <div class="sidebar-top">
      <button class="icon-btn" id="sideToggle" aria-label="Toggle menu">${icon('menu')}</button>
      <div class="side-tabs">
        <a class="side-tab ${location.pathname === '/' ? 'on' : ''}" href="/">Lobby</a>
        <a class="side-tab ${location.pathname.startsWith('/play') ? 'on' : ''}" href="/play">Play</a>
      </div>
    </div>
    <div class="side-scroll">
      <div class="side-group">
        ${navLink('/', 'home', 'Lobby')}
        ${navLink('/play', 'users', 'Play a Human')}
      </div>
      <div class="side-group">
        ${u ? navLink('/games', 'history', 'My Games') : ''}
        ${u ? `<a class="side-link" href="/wallet" title="Wallet">${icon('wallet')}<span>Wallet</span></a>` : ''}
        ${navLink('/fair-play', 'shield', 'Fair Play')}
        ${navLink('/support', 'help', 'Support')}
        ${u?.isAdmin ? navLink('/admin', 'admin', 'Admin') : ''}
      </div>
      ${store.config?.payments === 'crypto' ? '' : '<p class="side-note">Paper money. Balances have no cash value.</p>'}
    </div>`;
  el.querySelector('#sideToggle').onclick = () => {
    if (window.innerWidth <= 1000) { shell.classList.toggle('side-open'); return; }
    shell.classList.toggle('collapsed');
    try { localStorage.setItem('cb-collapsed', shell.classList.contains('collapsed') ? '1' : '0'); } catch {}
  };
}
document.getElementById('scrim').onclick = () => shell.classList.remove('side-open');

function renderHeader() {
  const u = store.user;
  const el = document.getElementById('header');
  const mobile = window.innerWidth <= 1000;
  el.innerHTML = `
    <div class="header-in">
      ${mobile ? `<button class="icon-btn" id="mMenu" aria-label="Menu">${icon('menu')}</button>` : ''}
      <a class="logo" href="/" aria-label="ChessBets home">${knightMark}<span class="word">ChessBets</span></a>
      <div class="header-mid">
        ${u ? `
          <div class="wallet-box">
            <button class="balance num" id="balBtn" title="Balance">
              <i class="coin">$</i><span id="balAmt">${money(u.balance)}</span>
              ${u.held ? `<span class="held" title="In play">+${money(u.held)} in play</span>` : ''}
            </button>
            <button class="btn btn-blue" id="walletBtn">${icon('wallet')}<span class="lbl">Wallet</span></button>
          </div>` : ''}
      </div>
      <div class="header-right">
        ${u ? `
          <div class="menu-wrap">
            <button class="icon-btn" id="userBtn" aria-label="Account">${icon('user')}</button>
          </div>` : `
          <button class="btn btn-ghost" id="loginBtn">Sign In</button>
          <button class="btn btn-blue" id="regBtn">Register</button>`}
      </div>
    </div>`;
  el.querySelector('#mMenu')?.addEventListener('click', () => shell.classList.toggle('side-open'));
  el.querySelector('#loginBtn')?.addEventListener('click', () => openAuth('login'));
  el.querySelector('#regBtn')?.addEventListener('click', () => openAuth('register'));
  el.querySelector('#walletBtn')?.addEventListener('click', () => openWallet());
  el.querySelector('#balBtn')?.addEventListener('click', () => openWallet());
  el.querySelector('#userBtn')?.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
}

function toggleMenu() {
  const wrap = document.querySelector('.menu-wrap');
  const open = wrap.querySelector('.menu');
  if (open) { open.remove(); return; }
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = `
    <div class="who">Signed in as <b>${esc(store.user.username)}</b></div>
    <a href="/games">${icon('history')}My Games</a>
    <button data-w>${icon('wallet')}Wallet</button>
    <a href="/fair-play">${icon('shield')}Fair Play</a>
    <a href="/support">${icon('help')}Support</a>
    ${store.user.isAdmin ? `<a href="/admin">${icon('admin')}Admin</a>` : ''}
    <button data-out>${icon('logout')}Sign Out</button>`;
  wrap.append(m);
  m.querySelector('[data-w]').onclick = () => { m.remove(); openWallet(); };
  m.querySelector('[data-out]').onclick = async () => {
    m.remove();
    await api('/api/logout', {});
    store.set({ user: null, activeGame: null, queue: null });
    ws.reconnect();
    navigate('/');
    toast('Signed out', { kind: 'info', ms: 2500 });
  };
  m.addEventListener('click', (e) => { if (e.target.closest('a')) m.remove(); });
  setTimeout(() => document.addEventListener('click', function off(e) {
    if (!m.contains(e.target)) { m.remove(); document.removeEventListener('click', off); }
  }), 0);
}

function renderSuspended() {
  const el = document.getElementById('susp');
  const u = store.user;
  if (!u || u.status !== 'suspended') { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="susp"><div class="susp-in">
      ${icon('lock')}
      <div><b>Your account is suspended for a fair-play violation.</b>
      <span>Your balance has been forfeited and will not be refunded. If you believe this is a mistake, contact support.</span></div>
      <a class="btn btn-gray btn-sm" href="/support">Contact support</a>
    </div></div>`;
}

function renderFooter() {
  const coins = store.config?.coins || [];
  document.getElementById('footer').innerHTML = `
    <div class="footer-in">
      <div>
        <a class="logo" href="/" style="margin-bottom:10px;display:inline-flex">${knightMark}<span>ChessBets</span></a>
        <p>${store.config?.payments === 'crypto'
          ? 'Skill-based chess competitions against real opponents. Deposits and withdrawals in crypto. 21+ only.'
          : 'Skill-based chess competitions against real opponents. This edition runs on paper money: deposits and withdrawals are simulated and balances have no cash value. 21+ only.'}</p>
      </div>
      <div><h4>Play</h4><a href="/play">Play a Human</a><a href="/games">My Games</a></div>
      <div><h4>Help</h4><a href="/fair-play">Fair Play</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/legal">Legal Basis</a><a href="/support">Support</a></div>
      <div class="footer-coins">
        ${[...new Set(coins.map((c) => c.label || c.code))].map((l) => `<span>${coinIcon(l)}${esc(l)}</span>`).join('')}
        <span class="copy">© ${new Date().getFullYear()} ChessBets. Crypto only.</span>
      </div>
    </div>`;
}

function renderMobileNav() {
  const p = location.pathname;
  const el = document.getElementById('mnav');
  el.innerHTML = `
    <a href="/" class="${p === '/' ? 'on' : ''}">${icon('home')}Lobby</a>
    <a href="/play" class="${p.startsWith('/play') ? 'on' : ''}">${icon('users')}Human</a>
    <a href="/fair-play" class="${p.startsWith('/fair-play') ? 'on' : ''}">${icon('shield')}Fair Play</a>
    <button data-w>${icon('wallet')}Wallet</button>
    <button data-m>${icon('menu')}Menu</button>`;
  el.querySelector('[data-w]').onclick = () => (store.user ? openWallet() : openAuth('login'));
  el.querySelector('[data-m]').onclick = () => shell.classList.toggle('side-open');
}

// ---- global reactions ----
bus.on('store', (patch) => {
  if ('user' in patch) { renderHeader(); renderSidebar(); renderSuspended(); }
});
bus.on('balance-up', () => {
  const b = document.getElementById('balBtn');
  if (b) { b.classList.remove('bump'); b.offsetWidth; b.classList.add('bump'); }
});
bus.on('matched', (m) => {
  sound.start();
  if (!location.pathname.startsWith(`/game/${m.id}`)) navigate(`/game/${m.id}`);
});
bus.on('suspended', () => { refreshMe(); });
bus.on('reinstated', () => { refreshMe(); toast('Your account has been reinstated', { kind: 'ok' }); });
bus.on('notice', (m) => {
  if (m.kind === 'refund') { sound.notify(); toast(`Refunded ${money(m.amount)}`, { kind: 'ok', body: 'An opponent who beat you was removed for fair play. Your entry fee is back.', ms: 8000 }); }
  if (m.kind === 'ticket') toast('Support replied to your ticket', { kind: 'info', body: 'Open Support to read it.' });
});
bus.on('wallet', (m) => {
  const tag = (x) => [x.coin_amount, String(x.coin || '').split('-')[0]].filter(Boolean).join(' ');
  if (m.deposit?.status === 'credited') { sound.notify(); toast(`Deposit confirmed: ${money(m.deposit.credited ?? m.deposit.amount)}`, { kind: 'ok', body: tag(m.deposit) }); }
  if (m.withdrawal?.status === 'completed') toast(`Withdrawal sent: ${money(m.withdrawal.net)}`, { kind: 'ok', body: tag(m.withdrawal) });
  if (m.withdrawal?.status === 'rejected') toast('Withdrawal declined', { kind: 'bad', body: `${money(m.withdrawal.amount)} is back in your balance.${m.withdrawal.note ? ` ${m.withdrawal.note}` : ''}`, ms: 8000 });
});
bus.on('error', (m) => { if (!m.silent) toast(m.message, { kind: 'bad' }); });

let wasMobile = window.innerWidth <= 1000;
window.addEventListener('resize', () => {
  const now = window.innerWidth <= 1000;
  if (now !== wasMobile) { wasMobile = now; renderHeader(); }
});

export function onSignedIn() {
  ws.reconnect();
  renderHeader();
  renderSidebar();
  renderSuspended();
}

// ---- boot ----
(async () => {
  try {
    await loadConfig();
  } catch {
    view.innerHTML = '<div class="empty" style="padding:80px 0">Could not reach the server. Retrying...</div>';
    setTimeout(() => location.reload(), 3000);
    return;
  }
  // Site made unavailable by an admin. The server only serves this page at
  // /login then, so staff can sign in; anyone else lands on the notice.
  if (store.config.maintenance && !store.user?.isAdmin) {
    if (store.user) return location.replace('/');
    shell.hidden = true;
    document.getElementById('mnav').hidden = true;
    openAuth('login', { then: () => location.replace('/') });
    return;
  }
  renderHeader();
  renderSuspended();
  renderFooter();
  connect();
  render();
})();

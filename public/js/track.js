import { store } from './store.js';

// Usage events for Admin > Analytics: page views, clicks, and the sign-up
// form and wallet opening. Sent in small batches to /api/t. Admins are never
// recorded, admin pages aren't either, and nothing typed into a field is sent.

const queue = [];
let timer = null;
let session = '';
try { session = sessionStorage.getItem('cb-s') || ''; } catch {}
if (!session) {
  session = Math.random().toString(36).slice(2, 12);
  try { sessionStorage.setItem('cb-s', session); } catch {}
}
let sentSource = false;

const page = () => location.pathname.replace(/^\/game\/[\w-]+$/, '/game/:id');
const off = () => store.user?.isAdmin || location.pathname.startsWith('/admin');

// Where this visit came from: ?utm_source=, else the referring site.
function source() {
  const utm = new URLSearchParams(location.search).get('utm_source');
  if (utm) return utm.toLowerCase().replace(/[^\w.:-]/g, '').slice(0, 60);
  try {
    const r = new URL(document.referrer);
    return r.host !== location.host ? r.hostname.replace(/^www\./, '') : '';
  } catch { return ''; }
}

export function track(k, l) {
  if (off()) return;
  const e = { k, p: page(), s: session, t: Date.now(), m: window.innerWidth <= 1000 };
  if (l) e.l = String(l).slice(0, 60);
  if (k === 'view' && !sentSource) { sentSource = true; const r = source(); if (r) e.r = r; }
  queue.push(e);
  if (queue.length >= 20) flush();
  else timer ||= setTimeout(flush, 4000);
}

function flush() {
  clearTimeout(timer);
  timer = null;
  if (!queue.length) return;
  fetch('/api/t', {
    method: 'POST', keepalive: true, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-cb': '1' },
    body: JSON.stringify({ e: queue.splice(0) }),
  }).catch(() => {});
}
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
addEventListener('pagehide', flush);

// Clicks on links and buttons, named by data-track, aria-label, title or
// their text.
document.addEventListener('click', (e) => {
  const el = e.target.closest?.('[data-track], a[href], button');
  if (!el) return;
  const name = el.dataset.track || el.getAttribute('aria-label') || el.getAttribute('title')
    || el.textContent.trim().replace(/\s+/g, ' ') || el.getAttribute('href');
  if (name) track('click', name.slice(0, 50));
}, true);

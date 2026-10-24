import { api, esc, icon, toast, dateTime } from '../lib.js';
import { store } from '../store.js';
import { requireUser } from './auth.js';

const TOPICS = ['Account suspension', 'Deposit or withdrawal', 'A game result', 'Report a player', 'Something else'];

export default function support(el) {
  const u = store.user;
  el.innerHTML = `
    <div class="prose" style="max-width:720px">
      <h1 class="page-title" style="font-size:24px">${icon('help')}Support</h1>
      ${u?.status === 'suspended' ? `
        <div class="callout red" style="font-size:13.5px">Your account is suspended. Its balance was forfeited and is not refundable. If you think this is a mistake, open a ticket below with the game in question and anything we should know. A person reviews every appeal.</div>` : `
        <p class="lede">Questions about a game, a payment or another player. We reply here, usually within a day.</p>`}
      <div id="sup"></div>
    </div>`;
  const box = el.querySelector('#sup');

  if (!u) {
    box.innerHTML = `<div class="card card-pad empty">Sign in to open a ticket.<div style="margin-top:14px"><button class="btn btn-blue" id="si">Sign In</button></div></div>`;
    box.querySelector('#si').onclick = () => requireUser(() => support(el));
    return;
  }

  box.innerHTML = `
    <form class="card card-pad" id="tf" novalidate>
      <div class="field"><label class="field-label" for="ts">Topic</label>
        <select class="input" id="ts">${TOPICS.map((t) => `<option ${u.status === 'suspended' && t === 'Account suspension' ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
      <div class="field"><label class="field-label" for="tb">Message</label>
        <textarea class="input" id="tb" maxlength="4000" placeholder="What happened? Include a game link if it is about a game."></textarea></div>
      <div class="form-error" id="te"></div>
      <button class="btn btn-blue" type="submit">Send ticket</button>
    </form>
    <h2 style="margin-top:28px">Your tickets</h2>
    <div id="tl"><div class="skel" style="height:80px"></div></div>`;

  const form = box.querySelector('#tf');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = box.querySelector('#te');
    err.textContent = '';
    try {
      await api('/api/tickets', { subject: box.querySelector('#ts').value, body: box.querySelector('#tb').value });
      box.querySelector('#tb').value = '';
      toast('Ticket sent', { kind: 'ok', body: 'We will reply here.' });
      list();
    } catch (ex) { err.textContent = ex.message; }
  };

  async function list() {
    const tl = box.querySelector('#tl');
    try {
      const { tickets } = await api('/api/tickets');
      tl.innerHTML = tickets.length ? tickets.map((t) => `
        <div class="ticket">
          <div class="ticket-head"><b>${esc(t.subject)}</b><span class="status ${t.status === 'answered' ? 'ok' : t.status === 'open' ? 'wait' : ''}">${{ open: 'Waiting for staff', answered: 'Answered', closed: 'Closed' }[t.status]}</span></div>
          ${t.messages.map((m) => `<div class="msg ${m.author}"><div class="meta">${m.author === 'staff' ? 'ChessBets support' : 'You'} · ${dateTime(m.created_at)}</div>${esc(m.body)}</div>`).join('')}
          ${t.status !== 'closed' ? `<div style="display:flex;gap:8px;margin-top:10px"><input class="input" data-r="${t.id}" placeholder="Reply"><button class="btn btn-gray" data-send="${t.id}">Send</button></div>` : ''}
        </div>`).join('') : '<div class="empty">No tickets yet.</div>';
      tl.querySelectorAll('[data-send]').forEach((b) => (b.onclick = async () => {
        const input = tl.querySelector(`[data-r="${b.dataset.send}"]`);
        if (!input.value.trim()) return;
        try { await api(`/api/tickets/${b.dataset.send}/reply`, { body: input.value }); list(); }
        catch (ex) { toast(ex.message, { kind: 'bad' }); }
      }));
    } catch (ex) { tl.innerHTML = `<div class="empty">${esc(ex.message)}</div>`; }
  }
  list();
}

import { openModal, closeModal, modalOpen, money, knightMark } from '../lib.js';
import { store } from '../store.js';
import { openAuth } from './auth.js';

// The sign-up bonus offer, shown once per visit to anyone signed out.
// The rules live in Terms section 19 (id "bonus").
const SEEN = 'cb-bonus-seen';
const QUIET = /^\/(terms|privacy|legal|fair-play|support|admin|login|register|wallet)\b/;

export function maybeShowBonus() {
  const b = store.config?.signupBonus;
  if (!b || store.user || modalOpen() || QUIET.test(location.pathname)) return;
  try { if (sessionStorage.getItem(SEEN)) return; sessionStorage.setItem(SEEN, '1'); } catch {}
  showBonus();
}

export function showBonus() {
  const b = store.config.signupBonus;
  const amt = money(b.amount).replace('.00', '');
  const min = money(b.minDeposit).replace('.00', '');
  const board = ['bK', '', '', 'bR', '', 'bP', 'bP', '', '', '', 'wN', '', 'wP', '', '', 'wK']
    .map((p, i) => `<span class="${(Math.floor(i / 4) + i) % 2 ? 'd' : 'l'}" ${p ? `style="background-image:url(/pieces/${p}.svg)"` : ''}></span>`).join('');

  const m = openModal({
    title: 'Sign-up bonus',
    width: 460,
    body: `
      <div class="promo-hero">
        <div class="promo-board mini-board" aria-hidden="true">${board}</div>
        <div class="promo-coin" aria-hidden="true"><span>${amt}</span><i>${knightMark}</i></div>
      </div>
      <div class="promo-copy">
        <span class="promo-tag">New player offer</span>
        <h2>Sign up and get <em>${amt}</em> to play</h2>
        <p>Create your account, deposit ${min} or more, and we add ${amt} to your balance for your next entry fee.</p>
        <ol class="promo-steps">
          <li><b>1</b>Create your account</li>
          <li><b>2</b>Deposit ${min}+ in crypto</li>
          <li><b>3</b>Get ${amt} in your balance</li>
        </ol>
        <button class="btn btn-green btn-lg" data-signup>Sign up</button>
        <p class="promo-alt">Already have an account? <button data-signin>Sign in</button></p>
      </div>`,
    foot: `See <a href="/terms#bonus">Section 19 of the Terms</a> for the terms of the bonus. You must sign up and deposit a minimum of ${min} to receive the ${amt} sign-up bonus. 21+ only.`,
  });
  m.root.querySelector('.modal').classList.add('promo-modal');
  m.body.querySelector('[data-signup]').onclick = () => { closeModal(); openAuth('register'); };
  m.body.querySelector('[data-signin]').onclick = () => { closeModal(); openAuth('login'); };
}

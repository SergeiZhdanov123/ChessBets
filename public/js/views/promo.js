import { openModal, closeModal, modalOpen, knightMark } from '../lib.js';
import { store } from '../store.js';
import { openAuth } from './auth.js';

// The sign-up popup, shown once per visit to anyone signed out.
const SEEN = 'cb-promo-seen';
const QUIET = /^\/(terms|privacy|legal|fair-play|support|admin|login|register|wallet)\b/;

export function maybeShowPromo() {
  if (store.user || modalOpen() || QUIET.test(location.pathname)) return;
  try { if (sessionStorage.getItem(SEEN)) return; sessionStorage.setItem(SEEN, '1'); } catch {}
  showPromo();
}

export function showPromo() {
  const board = ['bK', '', '', 'bR', '', 'bP', 'bP', '', '', '', 'wN', '', 'wP', '', '', 'wK']
    .map((p, i) => `<span class="${(Math.floor(i / 4) + i) % 2 ? 'd' : 'l'}" ${p ? `style="background-image:url(/pieces/${p}.svg)"` : ''}></span>`).join('');

  const m = openModal({
    title: 'Sign up',
    width: 460,
    body: `
      <div class="promo-hero">
        <div class="promo-board mini-board" aria-hidden="true">${board}</div>
        <div class="promo-coin" aria-hidden="true"><span>$</span><i>${knightMark}</i></div>
      </div>
      <div class="promo-copy">
        <span class="promo-tag">New to ChessBets?</span>
        <h2>Sign up today and <em>make money</em> playing chess</h2>
        <p>Play real opponents for real prizes. Win the game and the prize is yours.</p>
        <ol class="promo-steps">
          <li><b>1</b>Create your account</li>
          <li><b>2</b>Deposit in crypto</li>
          <li><b>3</b>Play for prizes</li>
        </ol>
        <button class="btn btn-green btn-lg" data-signup>Sign up</button>
        <p class="promo-alt">Already have an account? <button data-signin>Sign in</button></p>
      </div>`,
    foot: '21+ only. Only pay entry fees you can afford to lose. See the <a href="/terms">Terms</a>.',
  });
  m.root.querySelector('.modal').classList.add('promo-modal');
  m.body.querySelector('[data-signup]').onclick = () => { closeModal(); openAuth('register'); };
  m.body.querySelector('[data-signin]').onclick = () => { closeModal(); openAuth('login'); };
}

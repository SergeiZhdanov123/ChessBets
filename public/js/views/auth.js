import { api, openModal, closeModal, toast, esc } from '../lib.js';
import { store } from '../store.js';
import { onSignedIn } from '../app.js';

export function openAuth(mode = 'login', { then } = {}) {
  const m = openModal({
    title: mode === 'login' ? 'Sign In' : 'Create an account',
    width: 420,
    body: '',
    foot: mode === 'login'
      ? `Don't have an account? <button data-swap>Register</button>`
      : `Already have an account? <button data-swap>Sign in</button>`,
  });
  const form = document.createElement('form');
  form.noValidate = true;
  form.innerHTML = `
    <div class="field">
      <label class="field-label" for="au">Username</label>
      <input class="input" id="au" name="username" autocomplete="username" maxlength="16" spellcheck="false" required>
    </div>
    <div class="field">
      <label class="field-label" for="ap">Password ${mode === 'register' ? '<span class="aside">8 characters or more</span>' : ''}</label>
      <input class="input" id="ap" name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required>
    </div>
    ${mode === 'register' ? `
      <label class="check"><input type="checkbox" name="adult"> I am at least 18 years old.</label>
      <label class="check"><input type="checkbox" name="terms"> I accept the <a href="/terms" target="_blank">Terms</a> and the <a href="/fair-play" target="_blank">Fair Play rules</a>, including that suspended balances are not refunded.</label>
    ` : ''}
    <div class="form-error" role="alert"></div>
    <button class="btn btn-blue btn-lg" type="submit">${mode === 'login' ? 'Sign In' : 'Create account'}</button>`;
  m.body.append(form);
  m.root.querySelector('[data-swap]').onclick = () => openAuth(mode === 'login' ? 'register' : 'login', { then });
  const errEl = form.querySelector('.form-error');
  form.querySelector('#au').focus();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = { username: String(fd.get('username') || '').trim(), password: String(fd.get('password') || '') };
    if (mode === 'register') { body.adult = fd.get('adult') === 'on'; body.terms = fd.get('terms') === 'on'; }
    errEl.textContent = '';
    if (!body.username || !body.password) { errEl.textContent = 'Enter a username and password'; return; }
    if (mode === 'register' && (!body.adult || !body.terms)) { errEl.textContent = 'Tick both boxes to continue'; return; }
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      const r = await api(mode === 'login' ? '/api/login' : '/api/register', body);
      store.set({ user: r.user });
      closeModal();
      onSignedIn();
      toast(mode === 'login' ? `Welcome back, ${r.user.username}` : `Welcome, ${r.user.username}`, {
        kind: 'ok', body: mode === 'register' ? (store.config?.payments === 'crypto' ? 'Open the wallet to make a deposit.' : 'Open the wallet to add paper funds.') : '',
      });
      then?.();
    } catch (err) {
      errEl.innerHTML = esc(err.message);
      btn.disabled = false;
      btn.textContent = mode === 'login' ? 'Sign In' : 'Create account';
    }
  };
}

// Use before any action that needs an account.
export function requireUser(then) {
  if (store.user) return true;
  openAuth('login', { then });
  return false;
}

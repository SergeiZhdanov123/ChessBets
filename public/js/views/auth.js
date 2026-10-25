import { api, openModal, closeModal, toast, esc, icon } from '../lib.js';
import { store } from '../store.js';
import { onSignedIn } from '../app.js';

export function openAuth(mode = 'login', { then } = {}) {
  const reg = mode === 'register';
  const m = openModal({
    title: reg ? 'Create an account' : 'Sign in',
    width: 440,
    body: '',
    foot: reg
      ? `Already have an account? <button data-swap>Sign in</button>`
      : `Don't have an account? <button data-swap>Register</button>`,
  });
  m.root.querySelector('.modal').classList.add('auth-modal');
  const form = document.createElement('form');
  form.className = 'auth-form';
  form.noValidate = true;
  form.innerHTML = `
    <div class="field">
      <label class="field-label" for="au">Username ${reg ? '<span class="aside">3 to 16 letters, numbers or _</span>' : ''}</label>
      <input class="input" id="au" name="username" autocomplete="username" maxlength="16" spellcheck="false" autocapitalize="off" required>
    </div>
    <div class="field">
      <label class="field-label" for="ap">Password ${reg ? '<span class="aside">8 characters or more</span>' : ''}</label>
      <div class="input-wrap pw-wrap">
        <input class="input" id="ap" name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required>
        <button type="button" class="pw-toggle" aria-label="Show password" aria-pressed="false" title="Show password">${icon('eye')}</button>
      </div>
    </div>
    ${reg ? `
      <div class="auth-checks">
        <label class="check"><input type="checkbox" name="adult"> <span>I am at least 18 and of legal age to wager where I live.</span></label>
        <label class="check"><input type="checkbox" name="terms"> <span>I accept the <a href="/terms" target="_blank">Terms of Service</a>, <a href="/privacy" target="_blank">Privacy Policy</a> and <a href="/fair-play" target="_blank">Fair Play rules</a>, including that suspended balances are not refunded.</span></label>
      </div>
    ` : ''}
    <div class="form-error" role="alert"></div>
    <button class="btn btn-blue btn-lg" type="submit">${reg ? 'Create account' : 'Sign in'}</button>`;
  const pw = form.querySelector('#ap');
  const eye = form.querySelector('.pw-toggle');
  eye.onclick = () => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    eye.innerHTML = icon(show ? 'eye-off' : 'eye');
    eye.setAttribute('aria-pressed', String(show));
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    eye.title = show ? 'Hide password' : 'Show password';
    pw.focus();
    pw.setSelectionRange(pw.value.length, pw.value.length);
  };
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
      btn.textContent = reg ? 'Create account' : 'Sign in';
    }
  };
}

// Use before any action that needs an account.
export function requireUser(then) {
  if (store.user) return true;
  openAuth('login', { then });
  return false;
}

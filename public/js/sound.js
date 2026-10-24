// Synthesised board sounds. Short filtered noise bursts read as a piece on
// wood; tones are kept for notifications.

let ctx = null;
let muted = false;
try { muted = localStorage.getItem('cb-muted') === '1'; } catch {}

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// Browsers only allow audio after a gesture; unlock on the first one.
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => ac(), { once: true, passive: true });

function knock({ freq = 1800, q = 1.2, gain = 0.5, decay = 0.06, low = 160, lowGain = 0.25, delay = 0 }) {
  const a = ac();
  if (!a || muted) return;
  const t = a.currentTime + delay;
  const len = Math.floor(a.sampleRate * (decay + 0.03));
  const buf = a.createBuffer(1, len, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const src = a.createBufferSource();
  src.buffer = buf;
  const bp = a.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
  const g = a.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + decay);
  src.connect(bp).connect(g).connect(a.destination);
  src.start(t);

  const o = a.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(low, t);
  o.frequency.exponentialRampToValueAtTime(low * 0.6, t + decay);
  const og = a.createGain();
  og.gain.setValueAtTime(lowGain, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + decay + 0.02);
  o.connect(og).connect(a.destination);
  o.start(t);
  o.stop(t + decay + 0.05);
}

function tone(freq, { at = 0, dur = 0.12, gain = 0.12, type = 'triangle' } = {}) {
  const a = ac();
  if (!a || muted) return;
  const t = a.currentTime + at;
  const o = a.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export const sound = {
  move: () => knock({}),
  capture: () => { knock({ freq: 1400, gain: 0.6, decay: 0.07, lowGain: 0.32 }); knock({ freq: 2300, gain: 0.25, decay: 0.04, delay: 0.035 }); },
  check: () => { knock({ freq: 1600 }); tone(880, { at: 0.03, dur: 0.1, gain: 0.05 }); },
  castle: () => { knock({}); knock({ freq: 1500, delay: 0.09 }); },
  start: () => { tone(523, { dur: 0.1 }); tone(784, { at: 0.09, dur: 0.16 }); },
  win: () => { tone(523, { dur: 0.1 }); tone(659, { at: 0.09, dur: 0.1 }); tone(784, { at: 0.18, dur: 0.24 }); },
  lose: () => { tone(392, { dur: 0.14 }); tone(311, { at: 0.13, dur: 0.26 }); },
  draw: () => { tone(440, { dur: 0.12 }); tone(440, { at: 0.13, dur: 0.18 }); },
  low: () => tone(1046, { dur: 0.08, gain: 0.07, type: 'sine' }),
  notify: () => { tone(660, { dur: 0.08, gain: 0.07 }); tone(990, { at: 0.07, dur: 0.12, gain: 0.07 }); },
  forSan(san) {
    if (san.includes('#') || san.includes('+')) return this.check();
    if (san.startsWith('O-O')) return this.castle();
    if (san.includes('x')) return this.capture();
    return this.move();
  },
  get muted() { return muted; },
  toggle() {
    muted = !muted;
    try { localStorage.setItem('cb-muted', muted ? '1' : '0'); } catch {}
    return muted;
  },
};

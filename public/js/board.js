import { Chess } from '/vendor/chess.js';

// Interactive board: drag or click to move, premoves, promotion picker,
// right-click arrows and circles, animated position changes.

const FILES = 'abcdefgh';
const DRAG_PX = 4;
const SHAPE_COLORS = { g: 'rgba(21,120,27,0.8)', r: 'rgba(200,30,40,0.8)', b: 'rgba(0,48,136,0.8)', y: 'rgba(230,143,0,0.85)' };

const pieceUrl = (code) => `url(/pieces/${code}.svg)`;

export class Board {
  constructor(el, opts = {}) {
    this.el = el;
    this.opts = opts; // { orientation, onMove(from,to,promo), canMove(color)->bool, canPremove(color)->bool, onPremove(pm) }
    this.orientation = opts.orientation || 'w';
    this.pieces = new Map();
    this.chess = new Chess();
    this.lastMove = null;
    this.selected = null;
    this.dests = new Map();
    this.premove = null;
    this.shapes = [];
    this.viewOnly = false;

    el.classList.add('board');
    el.innerHTML = '<div class="layer hl"></div><div class="layer coords"></div><div class="layer pcs"></div><svg class="arrows" viewBox="0 0 800 800"><defs></defs><g></g></svg>';
    this.hlLayer = el.querySelector('.hl');
    this.pcLayer = el.querySelector('.pcs');
    this.coordLayer = el.querySelector('.coords');
    this.svg = el.querySelector('svg.arrows');
    this.svg.querySelector('defs').innerHTML = Object.entries(SHAPE_COLORS).map(([k, c]) =>
      `<marker id="ah-${k}" orient="auto" markerWidth="4" markerHeight="8" refX="2.05" refY="2.01"><path d="M0,0 V4 L3,2 Z" fill="${c}"/></marker>`).join('');

    this.onDown = this.onDown.bind(this);
    this.onMoveEv = this.onMoveEv.bind(this);
    this.onUp = this.onUp.bind(this);
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.renderCoords();
    this.setPosition(opts.fen || this.chess.fen(), { animate: false });
  }

  destroy() {
    this.el.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMoveEv);
    window.removeEventListener('pointerup', this.onUp);
    this.el.innerHTML = '';
  }

  // ---- geometry ----
  xy(sq) {
    const f = sq.charCodeAt(0) - 97, r = +sq[1] - 1;
    return this.orientation === 'w' ? { x: f, y: 7 - r } : { x: 7 - f, y: r };
  }
  sqAt(cx, cy) {
    const b = this.el.getBoundingClientRect();
    const x = Math.floor(((cx - b.left) / b.width) * 8);
    const y = Math.floor(((cy - b.top) / b.height) * 8);
    if (x < 0 || x > 7 || y < 0 || y > 7) return null;
    return this.orientation === 'w' ? FILES[x] + (8 - y) : FILES[7 - x] + (y + 1);
  }
  place(el, sq) {
    const { x, y } = this.xy(sq);
    el.style.transform = `translate(${x * 100}%, ${y * 100}%)`;
  }

  setOrientation(c) {
    if (c === this.orientation) return;
    this.orientation = c;
    this.renderCoords();
    for (const [sq, el] of this.pieces) { el.style.transition = 'none'; this.place(el, sq); }
    this.pcLayer.offsetWidth;
    for (const el of this.pieces.values()) el.style.transition = '';
    this.renderHighlights();
    this.renderShapes();
  }
  flip() { this.setOrientation(this.orientation === 'w' ? 'b' : 'w'); }

  renderCoords() {
    let html = '';
    for (let i = 0; i < 8; i++) {
      const file = this.orientation === 'w' ? FILES[i] : FILES[7 - i];
      const rank = this.orientation === 'w' ? 8 - i : i + 1;
      const fileLight = (i + 7) % 2 === 0;
      const rankLight = i % 2 === 0;
      html += `<span class="coord file ${fileLight ? 'on-light' : 'on-dark'}" style="left:${i * 12.5}%;width:12.5%;text-align:right;padding-right:3px;right:auto">${file}</span>`;
      html += `<span class="coord rank ${rankLight ? 'on-light' : 'on-dark'}" style="top:${i * 12.5}%">${rank}</span>`;
    }
    this.coordLayer.innerHTML = html;
  }

  // ---- position ----
  setPosition(fen, { lastMove = null, animate = true } = {}) {
    this.chess = new Chess(fen);
    this.lastMove = lastMove;
    const next = new Map();
    this.chess.board().forEach((row) => row.forEach((p) => p && next.set(p.square, p.color + p.type.toUpperCase())));

    const removed = [];
    const kept = new Set();
    for (const [sq, el] of this.pieces) {
      if (next.get(sq) === el.dataset.p) kept.add(sq);
      else removed.push({ sq, el });
    }
    const fresh = new Map();
    for (const [sq, code] of next) {
      if (kept.has(sq)) { fresh.set(sq, this.pieces.get(sq)); continue; }
      // Reuse the nearest vanished piece of the same kind so it slides over.
      let best = -1, bestD = 99;
      removed.forEach((r, i) => {
        if (r.el.dataset.p !== code) return;
        const a = this.xy(r.sq), b = this.xy(sq);
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < bestD) { bestD = d; best = i; }
      });
      let el;
      if (best >= 0 && animate) {
        el = removed.splice(best, 1)[0].el;
      } else {
        el = document.createElement('div');
        el.className = 'pc';
        el.dataset.p = code;
        el.style.backgroundImage = pieceUrl(code);
        el.style.transition = 'none';
        this.place(el, sq);
        this.pcLayer.append(el);
        el.offsetWidth;
        el.style.transition = '';
      }
      this.place(el, sq);
      fresh.set(sq, el);
    }
    for (const r of removed) {
      if (animate) { r.el.classList.add('fade'); setTimeout(() => r.el.remove(), 160); }
      else r.el.remove();
    }
    this.pieces = fresh;
    this.selected = null;
    this.dests = new Map();
    this.renderHighlights();
    this.tryPremove();
  }

  // ---- highlights ----
  renderHighlights(hover = null) {
    const parts = [];
    const add = (sq, cls) => {
      const { x, y } = this.xy(sq);
      parts.push(`<div class="sq ${cls}" style="left:${x * 12.5}%;top:${y * 12.5}%"></div>`);
    };
    if (this.lastMove) { add(this.lastMove[0], 'last'); add(this.lastMove[1], 'last'); }
    if (this.premove) { add(this.premove.from, 'pre'); add(this.premove.to, 'pre'); }
    if (this.chess.inCheck()) {
      const t = this.chess.turn();
      this.chess.board().forEach((row) => row.forEach((p) => { if (p && p.type === 'k' && p.color === t) add(p.square, 'check'); }));
    }
    if (this.selected) {
      add(this.selected, 'sel');
      for (const d of this.dests.get(this.selected) || []) add(d, this.chess.get(d) ? 'dest cap' : 'dest');
    }
    if (hover) add(hover, 'hover');
    this.hlLayer.innerHTML = parts.join('');
  }

  // Legal destinations when it is our turn; loose geometric ones for premoves.
  computeDests(sq) {
    const p = this.chess.get(sq);
    if (!p || this.viewOnly) return null;
    if (p.color === this.chess.turn() && this.opts.canMove?.(p.color)) {
      const out = this.chess.moves({ square: sq, verbose: true }).map((m) => m.to);
      return { list: [...new Set(out)], pre: false };
    }
    if (p.color !== this.chess.turn() && this.opts.canPremove?.(p.color)) return { list: premoveDests(this.chess, sq, p), pre: true };
    return null;
  }

  select(sq) {
    const d = this.computeDests(sq);
    if (!d) { this.selected = null; this.dests = new Map(); this.renderHighlights(); return false; }
    this.selected = sq;
    this.dests = new Map([[sq, d.list]]);
    this.selPre = d.pre;
    this.renderHighlights();
    return true;
  }

  // ---- pointer input ----
  onDown(e) {
    if (e.button === 2) return this.shapeStart(e);
    if (e.button !== 0) return;
    if (this.shapes.length) { this.shapes = []; this.renderShapes(); }
    const sq = this.sqAt(e.clientX, e.clientY);
    if (!sq) return;
    e.preventDefault();

    if (this.premove && !this.selected) { this.cancelPremove(); }

    // Second click: complete a move to a highlighted square.
    if (this.selected && sq !== this.selected && (this.dests.get(this.selected) || []).includes(sq)) {
      this.attempt(this.selected, sq);
      return;
    }
    const piece = this.chess.get(sq);
    const wasSelected = this.selected === sq;
    if (!piece || !this.select(sq)) { this.selected = null; this.dests = new Map(); this.renderHighlights(); return; }

    const el = this.pieces.get(sq);
    this.drag = { from: sq, el, x: e.clientX, y: e.clientY, started: false, wasSelected };
    window.addEventListener('pointermove', this.onMoveEv);
    window.addEventListener('pointerup', this.onUp);
  }

  onMoveEv(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.started && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_PX) return;
    d.started = true;
    const b = this.el.getBoundingClientRect();
    const size = b.width / 8;
    d.el.classList.add('drag');
    d.el.style.transform = `translate(${e.clientX - b.left - size / 2}px, ${e.clientY - b.top - size / 2}px)`;
    const over = this.sqAt(e.clientX, e.clientY);
    if (over !== d.over) { d.over = over; this.renderHighlights(over && over !== d.from ? over : null); }
  }

  onUp(e) {
    window.removeEventListener('pointermove', this.onMoveEv);
    window.removeEventListener('pointerup', this.onUp);
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (!d.started) {
      // A plain click on an already-selected piece toggles it off.
      if (d.wasSelected) { this.selected = null; this.dests = new Map(); this.renderHighlights(); }
      return;
    }
    const to = this.sqAt(e.clientX, e.clientY);
    const ok = to && to !== d.from && (this.dests.get(d.from) || []).includes(to);
    if (ok) {
      this.attempt(d.from, to, d.el);
    } else {
      d.el.classList.remove('drag');
      this.place(d.el, d.from);
      this.renderHighlights();
    }
  }

  attempt(from, to, dragEl) {
    const p = this.chess.get(from);
    const pre = this.selPre;
    const promo = p?.type === 'p' && (to[1] === '8' || to[1] === '1');
    const finish = (promotion) => {
      this.selected = null;
      this.dests = new Map();
      if (pre) {
        this.premove = { from, to, promotion: promotion || 'q', color: p.color };
        if (dragEl) { dragEl.classList.remove('drag'); this.place(dragEl, from); }
        this.renderHighlights();
        this.opts.onPremove?.(this.premove);
        return;
      }
      const accepted = this.opts.onMove?.(from, to, promotion);
      if (dragEl) {
        dragEl.classList.remove('drag');
        if (!accepted) this.place(dragEl, from);
      }
      this.renderHighlights();
    };
    if (promo && !pre) return this.askPromotion(to, p.color, (choice) => {
      if (!choice) { if (dragEl) { dragEl.classList.remove('drag'); this.place(dragEl, from); } this.renderHighlights(); return; }
      finish(choice);
    });
    finish(promo ? 'q' : undefined);
  }

  askPromotion(to, color, cb) {
    const { x, y } = this.xy(to);
    const down = y === 0;
    const dim = document.createElement('div');
    dim.className = 'board-dim';
    const box = document.createElement('div');
    box.className = 'promo';
    box.style.left = `${x * 12.5}%`;
    box.style[down ? 'top' : 'bottom'] = '0';
    for (const t of ['Q', 'N', 'R', 'B']) {
      const b = document.createElement('button');
      b.style.backgroundImage = pieceUrl(color + t);
      b.setAttribute('aria-label', { Q: 'Queen', N: 'Knight', R: 'Rook', B: 'Bishop' }[t]);
      b.onclick = (ev) => { ev.stopPropagation(); close(t.toLowerCase()); };
      down ? box.append(b) : box.prepend(b);
    }
    const close = (choice) => { dim.remove(); box.remove(); cb(choice); };
    dim.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); close(null); });
    box.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    this.el.append(dim, box);
  }

  cancelPremove() {
    if (!this.premove) return;
    this.premove = null;
    this.renderHighlights();
    this.opts.onPremove?.(null);
  }

  tryPremove() {
    const pm = this.premove;
    if (!pm || this.chess.turn() !== pm.color || !this.opts.canMove?.(pm.color)) return;
    this.premove = null;
    const legal = this.chess.moves({ square: pm.from, verbose: true }).some((m) => m.to === pm.to);
    this.opts.onPremove?.(null);
    if (!legal) { this.renderHighlights(); return; }
    queueMicrotask(() => {
      this.opts.onMove?.(pm.from, pm.to, this.chess.get(pm.from)?.type === 'p' && /[18]$/.test(pm.to) ? pm.promotion : undefined, { premove: true });
    });
  }

  // ---- right-click shapes ----
  shapeStart(e) {
    const from = this.sqAt(e.clientX, e.clientY);
    if (!from) return;
    if (this.selected || this.premove) { this.selected = null; this.dests = new Map(); this.cancelPremove(); this.renderHighlights(); }
    const color = e.shiftKey ? 'r' : e.altKey ? 'b' : e.ctrlKey || e.metaKey ? 'y' : 'g';
    const up = (ev) => {
      window.removeEventListener('pointerup', up);
      const to = this.sqAt(ev.clientX, ev.clientY);
      if (!to) return;
      const i = this.shapes.findIndex((s) => s.from === from && s.to === to);
      if (i >= 0) this.shapes.splice(i, 1);
      else this.shapes.push({ from, to, color });
      this.renderShapes();
    };
    window.addEventListener('pointerup', up);
  }

  renderShapes() {
    const c = (sq) => { const { x, y } = this.xy(sq); return [x * 100 + 50, y * 100 + 50]; };
    this.svg.querySelector('g').innerHTML = this.shapes.map((s) => {
      const col = SHAPE_COLORS[s.color];
      const [x1, y1] = c(s.from);
      if (s.from === s.to) return `<circle cx="${x1}" cy="${y1}" r="44" fill="none" stroke="${col}" stroke-width="7"/>`;
      let [x2, y2] = c(s.to);
      const len = Math.hypot(x2 - x1, y2 - y1);
      x2 -= ((x2 - x1) / len) * 22; y2 -= ((y2 - y1) / len) * 22;
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="15" stroke-linecap="round" marker-end="url(#ah-${s.color})" opacity=".9"/>`;
    }).join('');
  }
}

// Premove targets: everything the piece could reach on a board where the
// opponent might move anything, so sliders ignore blockers.
function premoveDests(_chess, sq, p) {
  const f = sq.charCodeAt(0) - 97, r = +sq[1] - 1;
  const out = [];
  const add = (df, dr) => {
    const nf = f + df, nr = r + dr;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) out.push(FILES[nf] + (nr + 1));
  };
  const ray = (df, dr) => { for (let i = 1; i < 8; i++) add(df * i, dr * i); };
  switch (p.type) {
    case 'p': {
      const dir = p.color === 'w' ? 1 : -1;
      add(0, dir);
      if ((p.color === 'w' && r === 1) || (p.color === 'b' && r === 6)) add(0, 2 * dir);
      add(-1, dir); add(1, dir);
      break;
    }
    case 'n': [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]].forEach(([a, b]) => add(a, b)); break;
    case 'b': [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([a, b]) => ray(a, b)); break;
    case 'r': [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([a, b]) => ray(a, b)); break;
    case 'q': [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([a, b]) => ray(a, b)); break;
    case 'k':
      [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([a, b]) => add(a, b));
      if ((p.color === 'w' && sq === 'e1') || (p.color === 'b' && sq === 'e8')) { add(2, 0); add(-2, 0); }
      break;
  }
  return out;
}

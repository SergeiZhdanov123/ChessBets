// House bots. Each one plays at full strength; what differs is the opening
// repertoire, the pace, and how it carries itself on the page.

export const BOTS = {
  hikaru: {
    id: 'hikaru',
    name: 'Hikaru',
    fullName: 'Hikaru Nakamura',
    blurb: 'Fast hands and a nose for tactics. Moves quickly, rarely lets a loose piece go.',
    style: 'Speed and tactics',
    think: [400, 1200],
    book: {
      w: [
        'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3',
        'e4 e5 Nf3 Nc6 Bc4 Nf6 d3',
        'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3',
        'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5 Ndb5 d6',
        'e4 e6 d4 d5 Nc3 Nf6 e5 Nfd7 f4',
        'e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2',
        'd4 Nf6 c4 e6 Nf3 d5 Nc3 Be7 Bf4',
        'd4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4',
        'Nf3 d5 g3 Nf6 Bg2 c6 O-O',
      ],
      b: [
        'e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4 Nd6 Bxc6 dxc6 dxe5 Nf5',
        'e4 e5 Nf3 Nc6 Bc4 Bc5',
        'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6',
        'e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Bc5',
        'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5',
        'd4 Nf6 c4 g6 Nf3 Bg7 g3 O-O Bg2 d6',
        'd4 Nf6 Nf3 g6 c4 Bg7',
        'c4 Nf6 Nc3 g6 e4 d6',
        'Nf3 Nf6 c4 g6 Nc3 Bg7',
      ],
    },
    look: { bg: '#2f4553', skin: '#e7b98f', hair: '#16181d', hairStyle: 'short', shirt: '#1c4f8f', collar: '#1c4f8f', jacket: null },
  },
  magnus: {
    id: 'magnus',
    name: 'Magnus',
    fullName: 'Magnus Carlsen',
    blurb: 'Takes a small edge and keeps squeezing. Patient in quiet positions and lethal in endgames.',
    style: 'Positional pressure',
    think: [700, 1800],
    book: {
      w: [
        'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3',
        'e4 c5 Nf3 d6 Bb5+ Bd7 Bxd7+ Qxd7 O-O',
        'e4 c5 Nf3 Nc6 Bb5 g6 O-O Bg7',
        'd4 Nf6 c4 e6 Nf3 d5 g3 Be7 Bg2 O-O O-O',
        'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3',
        'c4 e5 Nc3 Nf6 g3 d5 cxd5 Nxd5 Bg2',
        'Nf3 Nf6 c4 e6 g3 d5 Bg2',
      ],
      b: [
        'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5 Ndb5 d6 Bg5 a6 Na3 b5',
        'e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4 Nd6 Bxc6 dxc6 dxe5 Nf5',
        'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6',
        'e4 c6 d4 d5 e5 Bf5',
        'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O',
        'd4 Nf6 c4 e6 Nf3 d5 Nc3 Be7',
        'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7',
        'c4 e5 Nc3 Nf6 g3 d5',
        'Nf3 d5 g3 c6 Bg2 Bg4',
      ],
    },
    look: { bg: '#3b5266', skin: '#f0c7a6', hair: '#8a5a33', hairStyle: 'swept', shirt: '#f2f4f7', collar: '#f2f4f7', jacket: '#1f2a3c' },
  },
  kasparov: {
    id: 'kasparov',
    name: 'Kasparov',
    fullName: 'Garry Kasparov',
    blurb: 'Dynamic, aggressive, deeply prepared. Plays for the initiative from the first move.',
    style: 'Attack and preparation',
    think: [900, 2200],
    book: {
      w: [
        'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be6 f3',
        'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6 Nc3 Qc7 Be3',
        'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 O-O c3 d5',
        'e4 e6 d4 d5 Nc3 Bb4 e5 c5 a3',
        'd4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3 bxc3 Bg7',
        'd4 d5 c4 e6 Nc3 Nf6 cxd5 exd5 Bg5',
        'd4 Nf6 c4 e6 Nc3 Bb4 Qc2 O-O a3',
        'c4 Nf6 Nc3 e5 Nf3 Nc6 g3',
      ],
      b: [
        'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5',
        'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Bg5 e6 f4',
        'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6',
        'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7',
        'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5 O-O Nc6 d5 Ne7',
        'd4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3 bxc3 Bg7',
        'd4 Nf6 Nf3 g6 c4 Bg7 Nc3 d5',
        'c4 e5 Nc3 Nf6 Nf3 Nc6',
        'Nf3 Nf6 c4 g6 Nc3 d5',
      ],
    },
    look: { bg: '#4a3b35', skin: '#d9a982', hair: '#3a2f2a', hairStyle: 'curly', shirt: '#e8ebef', collar: '#e8ebef', jacket: '#262a31', tie: '#7a1f2b' },
  },
};

export const botList = () => Object.values(BOTS).map(({ book, think, ...pub }) => pub);

const BOOKS = Object.fromEntries(
  Object.values(BOTS).map((b) => [b.id, { w: b.book.w.map((l) => l.split(' ')), b: b.book.b.map((l) => l.split(' ')) }]),
);

// Pick a repertoire move if the game so far is a prefix of one of the bot's
// lines. The bot only follows theory; it never plays a book move from a
// position the book did not anticipate.
export function bookMove(botId, color, sanHistory, rand = Math.random) {
  const lines = BOOKS[botId]?.[color] || [];
  const n = sanHistory.length;
  const options = new Set();
  for (const line of lines) {
    if (line.length <= n) continue;
    let ok = true;
    for (let i = 0; i < n; i++) if (line[i] !== sanHistory[i]) { ok = false; break; }
    if (ok) options.add(line[n]);
  }
  const arr = [...options];
  return arr.length ? arr[Math.floor(rand() * arr.length)] : null;
}

// Think time for an engine move, in ms. Faster when the bot's clock runs low,
// a touch slower in the middlegame.
export function thinkTime(botId, { ply, clockMs }, scale = 1, rand = Math.random) {
  const [lo, hi] = BOTS[botId].think;
  let t = lo + rand() * (hi - lo);
  if (ply > 20 && ply < 70) t *= 1.25;
  if (clockMs < 5 * 60_000) t *= 0.5;
  if (clockMs < 60_000) t = Math.min(t, 400);
  return Math.max(50, Math.round(t * scale));
}

// Legal moves that would end the game in a draw on the spot: stalemate,
// threefold repetition, the 50-move rule, or bare material. Uses the game's
// own Chess instance (it has the move history) and leaves it unchanged.
export function drawingMoves(chess) {
  const out = new Set();
  for (const m of chess.moves({ verbose: true })) {
    chess.move(m);
    if (chess.isStalemate() || chess.isThreefoldRepetition() || chess.isInsufficientMaterial() || chess.isDrawByFiftyMoves()) {
      out.add(m.from + m.to + (m.promotion || ''));
    }
    chess.undo();
  }
  return out;
}

// A UCI "engine" that starts up fine and then never answers a search, the
// way a stalled Stockfish would.
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line === 'uci') process.stdout.write('id name stuck\nuciok\n');
    else if (line === 'isready') process.stdout.write('readyok\n');
    else if (line === 'quit') process.exit(0);
  }
});

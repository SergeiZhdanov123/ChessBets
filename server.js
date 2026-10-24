// ChessBets entry point: `node server.js`
// node:sqlite still prints an ExperimentalWarning on Node 22; it is noise.
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => {
  if (String(w?.message || w).includes('SQLite')) return;
  return emit.call(process, w, ...rest);
};

const { config } = await import('./src/config.js');
const { createApp } = await import('./src/app.js');

const { server, ctx, recovered } = await createApp();
if (recovered.games || recovered.holds) {
  console.log(`Recovered after restart: voided ${recovered.games} unfinished game(s), returned ${recovered.holds} open stake(s).`);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${config.port} is already in use. Start with PORT=<other> node server.js`);
  else console.error(err);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log(`ChessBets (paper money) running at http://localhost:${config.port}`);
});

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) process.exit(1);
    closing = true;
    console.log('\nShutting down...');
    await ctx.close().catch(() => {});
    process.exit(0);
  });
}

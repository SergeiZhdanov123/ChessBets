// ChessBets entry point: `node server.js`
import fs from 'node:fs';

// Local settings (MONGODB_URI and friends) live in .env. Variables already
// set in the environment, as on Render, take precedence.
if (fs.existsSync('.env')) process.loadEnvFile('.env');

const { config } = await import('./src/config.js');
const { createApp } = await import('./src/app.js');

let started;
try {
  started = await createApp();
} catch (err) {
  console.error(`Could not start: ${err.message}`);
  if (/auth/i.test(err.message)) console.error('Check the username and password in MONGODB_URI.');
  if (err.name === 'MongoServerSelectionError') console.error('MongoDB did not answer. On Atlas, check Network Access allows this machine (0.0.0.0/0 for Render).');
  process.exit(1);
}
const { server, ctx, recovered } = started;
if (recovered.games || recovered.holds) {
  console.log(`Recovered after restart: voided ${recovered.games} unfinished game(s), returned ${recovered.holds} open stake(s).`);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${config.port} is already in use. Start with PORT=<other> node server.js`);
  else console.error(err);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log(`ChessBets (${config.payments === 'bcon' ? 'crypto payments via Bcon' : 'paper money'}) running at http://localhost:${config.port} (database "${config.mongoDb}")`);
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

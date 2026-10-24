// Usage: npm run make-admin -- <username>
import fs from 'node:fs';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const { config } = await import('../src/config.js');
const { openDb } = await import('../src/db.js');

const name = process.argv[2];
if (!name) {
  console.error('Usage: npm run make-admin -- <username>');
  process.exit(1);
}
const db = await openDb({ uri: config.mongoUri, name: config.mongoDb });
const r = await db.users.update({ username_lc: name.toLowerCase() }, { $set: { is_admin: 1 } });
console.log(r.matchedCount ? `${name} is now an admin.` : `No user named ${name}.`);
await db.close();

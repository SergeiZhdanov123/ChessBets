// Usage: npm run make-admin -- <username>
const emit = process.emitWarning;
process.emitWarning = (w, ...r) => (String(w?.message || w).includes('SQLite') ? undefined : emit.call(process, w, ...r));

const { config } = await import('../src/config.js');
const { openDb } = await import('../src/db.js');

const name = process.argv[2];
if (!name) {
  console.error('Usage: npm run make-admin -- <username>');
  process.exit(1);
}
const db = openDb(config.dbPath);
const r = db.run('UPDATE users SET is_admin = 1 WHERE username_lc = ?', name.toLowerCase());
console.log(r.changes ? `${name} is now an admin.` : `No user named ${name}.`);
db.close();

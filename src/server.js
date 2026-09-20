import { createApp } from './app.js';
import { config } from './config.js';
import { get } from './db/index.js';
import { seedDatabase } from './db/seed.js';

const app = createApp();

/**
 * A fresh clone has no database file, because `data/` is not tracked in git.
 * Rather than presenting a login screen that nothing can sign in to, create
 * the demo data on first run. This never happens in production, where real
 * accounts are expected and a known password would be a security hole.
 */
async function ensureAccountsExist() {
  if (get('SELECT COUNT(*) AS n FROM users').n > 0) return false;

  if (config.isProduction) {
    console.log('\n  The database is empty and NODE_ENV=production, so no demo');
    console.log('  accounts were created. Run "npm run seed" to add them, or');
    console.log('  create your first administrator directly.\n');
    return false;
  }

  console.log('\n  First run — creating demo data…');
  await seedDatabase({ quiet: true });
  return true;
}

const seeded = await ensureAccountsExist();

const server = app.listen(config.port, () => {
  const users = get('SELECT COUNT(*) AS n FROM users').n;

  console.log(`\n  Attendance Tracking System`);
  console.log(`  ──────────────────────────`);
  console.log(`  Running at  http://localhost:${config.port}`);
  console.log(`  Database    ${config.databaseFile}`);
  console.log(`  Accounts    ${users}`);

  if (users > 0) {
    console.log(`\n  Sign in with password "${config.seedPassword}":`);
    console.log(`    admin    admin@college.edu`);
    console.log(`    teacher  sunita.rao@college.edu`);
    console.log(`    student  aarav.sharma1@student.college.edu`);
  }
  if (seeded) {
    console.log(`\n  (Run "npm run reset" at any time to start from scratch.)`);
  }
  console.log('');
});

const shutdown = (signal) => {
  console.log(`\n${signal} received, shutting down.`);
  server.close(() => process.exit(0));
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

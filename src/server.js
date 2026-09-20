import { createApp } from './app.js';
import { config } from './config.js';
import { bootstrapAdmin, ensureStarterData, userCount } from './db/bootstrap.js';

const app = createApp();

let seedResult;
try {
  seedResult = await ensureStarterData();
} catch (error) {
  console.error('\n  Could not create the starter data:', error.message);
  seedResult = 'failed';
}

let adminResult = null;
try {
  adminResult = await bootstrapAdmin();
} catch (error) {
  console.error('\n  Could not apply ADMIN_EMAIL / ADMIN_PASSWORD:', error.message);
}

const server = app.listen(config.port, () => {
  const users = userCount();

  console.log(`\n  Attendance Tracking System`);
  console.log(`  ──────────────────────────`);
  console.log(`  Listening on port ${config.port}`);
  console.log(`  Database          ${config.databaseFile}`);
  console.log(`  Environment       ${config.isProduction ? 'production' : 'development'}`);
  console.log(`  Accounts          ${users}`);

  if (seedResult === 'seeded') {
    console.log(`\n  Created the demo data (first run).`);
  }
  if (adminResult) {
    console.log(`\n  Administrator ${adminResult} from ADMIN_EMAIL: ${config.adminEmail}`);
  }

  if (users === 0) {
    // The only way to reach this is a production deploy with nothing configured.
    console.log(`
  ────────────────────────────────────────────────────────────
  There are no accounts, so no one can sign in yet.

  This is a production deployment, so demo accounts are not
  created automatically. Set environment variables on your host
  and redeploy — either:

    ADMIN_EMAIL     you@example.com      (your real admin login)
    ADMIN_PASSWORD  something-private

  or, to load the full demo dataset instead:

    SEED_DEMO_DATA  true

  See the "Deploying" section of the README.
  ────────────────────────────────────────────────────────────
`);
    return;
  }

  if (!config.isProduction || seedResult === 'seeded') {
    console.log(`\n  Sign in with password "${config.seedPassword}":`);
    console.log(`    admin    admin@college.edu`);
    console.log(`    teacher  sunita.rao@college.edu`);
    console.log(`    student  aarav.sharma1@student.college.edu`);
  }

  if (config.isProduction && seedResult === 'seeded') {
    console.log(`
  WARNING: demo accounts were created on a production deployment
  because SEED_DEMO_DATA is set. Their password is public in the
  README. Remove SEED_DEMO_DATA and set ADMIN_EMAIL /
  ADMIN_PASSWORD before using this with real data.`);
  }

  console.log('');
});

const shutdown = (signal) => {
  console.log(`\n${signal} received, shutting down.`);
  server.close(() => process.exit(0));
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

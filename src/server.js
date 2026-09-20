import { createApp } from './app.js';
import { config } from './config.js';
import { get } from './db/index.js';

const app = createApp();

const server = app.listen(config.port, () => {
  const users = get('SELECT COUNT(*) AS n FROM users').n;

  console.log(`\n  Attendance Tracking System`);
  console.log(`  ──────────────────────────`);
  console.log(`  Running at  http://localhost:${config.port}`);
  console.log(`  Database    ${config.databaseFile}`);

  if (users === 0) {
    console.log(`\n  No users yet — run "npm run seed" to create demo accounts.\n`);
  } else {
    console.log(`  Accounts    ${users}\n`);
  }
});

const shutdown = (signal) => {
  console.log(`\n${signal} received, shutting down.`);
  server.close(() => process.exit(0));
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/**
 * Prints everything needed to explain a "database is empty" or failed login,
 * and fixes the empty case on the spot.
 *
 *   npm run doctor
 */
import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { all, get } from './db/index.js';
import { seedDatabase } from './db/seed.js';
import { formatAmount } from './utils/money.js';

const line = () => console.log('─'.repeat(62));

console.log('\nAttendance Tracking System — diagnostics');
line();

console.log(`Node version      ${process.versions.node}`);
console.log(`Working directory ${process.cwd()}`);
console.log(`NODE_ENV          ${process.env.NODE_ENV ?? '(not set)'}`);
console.log(`.env file         ${fs.existsSync('.env') ? 'present' : 'not present (fine — defaults are used)'}`);
console.log(`Database file     ${config.databaseFile}`);

const exists = fs.existsSync(config.databaseFile);
console.log(`Database exists   ${exists ? `yes (${fs.statSync(config.databaseFile).size} bytes)` : 'no — it will be created'}`);

line();

let users = get('SELECT COUNT(*) AS n FROM users').n;
console.log(`Accounts found    ${users}`);

if (users === 0) {
  console.log('\nThe database has no accounts, which is why the login screen says');
  console.log('it is empty. Creating the demo data now…\n');

  try {
    await seedDatabase({ quiet: true });
  } catch (error) {
    console.error('Could not create the demo data:', error.message);
    console.error('\nFull error:\n', error);
    process.exit(1);
  }

  users = get('SELECT COUNT(*) AS n FROM users').n;

  if (users === 0) {
    console.error('The seed ran but wrote nothing. This is a bug — please report it.');
    process.exit(1);
  }
  console.log(`Created ${users} accounts.`);
}

line();

// Prove the documented credentials actually work against what is stored.
console.log('\nChecking the demo logins:\n');

const demo = [
  ['admin', 'admin@college.edu'],
  ['teacher', 'sunita.rao@college.edu'],
  ['student', 'aarav.sharma1@student.college.edu']
];

let allGood = true;

for (const [role, email] of demo) {
  const user = get('SELECT password_hash, is_active FROM users WHERE email = :email', { email });

  if (!user) {
    console.log(`  MISSING  ${role.padEnd(8)} ${email}`);
    allGood = false;
    continue;
  }

  const passwordOk = await bcrypt.compare(config.seedPassword, user.password_hash);

  if (!passwordOk) {
    console.log(`  BAD PW   ${role.padEnd(8)} ${email}  (password was changed)`);
    allGood = false;
  } else if (user.is_active !== 1) {
    console.log(`  INACTIVE ${role.padEnd(8)} ${email}`);
    allGood = false;
  } else {
    console.log(`  OK       ${role.padEnd(8)} ${email}`);
  }
}

const counts = get(`
  SELECT (SELECT COUNT(*) FROM courses)            AS courses,
         (SELECT COUNT(*) FROM enrollments)        AS enrollments,
         (SELECT COUNT(*) FROM attendance)         AS attendance,
         (SELECT COUNT(*) FROM expense_categories) AS categories,
         (SELECT COUNT(*) FROM expenses)           AS expenses,
         (SELECT IFNULL(SUM(amount), 0) FROM expenses WHERE status = 'pending') AS pending`);

console.log(`\nData: ${counts.courses} courses, ${counts.enrollments} enrollments, ${counts.attendance} attendance records.`);
console.log(
  `Expenses: ${counts.expenses} across ${counts.categories} categories, ` +
    `${formatAmount(counts.pending)} ${config.currency} awaiting approval.`
);

line();

if (allGood) {
  console.log(`\nEverything is in order. Start the app with:\n`);
  console.log(`  npm start\n`);
  console.log(`Then open http://localhost:${config.port} and sign in with`);
  console.log(`password "${config.seedPassword}":\n`);
  for (const [role, email] of demo) console.log(`  ${role.padEnd(8)} ${email}`);
  console.log('');
} else {
  console.log('\nSome accounts are not usable. To wipe everything and start over:\n');
  console.log('  npm run reset\n');

  const others = all("SELECT email, role FROM users WHERE role != 'student' ORDER BY id LIMIT 5");
  if (others.length) {
    console.log('Staff accounts currently in the database:');
    for (const row of others) console.log(`  ${row.role.padEnd(8)} ${row.email}`);
    console.log('');
  }
}

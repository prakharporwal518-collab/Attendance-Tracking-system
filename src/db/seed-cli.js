/**
 * Command-line entry point for seeding:  npm run seed  /  npm run reset
 *
 * This is a separate file so that seeding never depends on detecting whether
 * seed.js "was run directly" — a check that can quietly fail and leave you
 * with an empty database and no error to explain it.
 */
import { seedDatabase } from './seed.js';

const reset = process.argv.includes('--reset');

try {
  const wrote = await seedDatabase({ reset });
  if (!wrote) {
    console.log('\nNothing to do. Use "npm run reset" to wipe and recreate the data.\n');
  }
} catch (error) {
  console.error('\nSeeding failed:', error.message);
  console.error(error);
  process.exit(1);
}

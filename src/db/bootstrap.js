/**
 * Everything that has to happen before the first request can succeed on a
 * freshly deployed instance, where nobody can open a terminal and run a
 * setup command.
 */
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { get, run } from './index.js';
import { seedDatabase } from './seed.js';

const userCount = () => get('SELECT COUNT(*) AS n FROM users').n;

/**
 * Create or update the administrator described by ADMIN_EMAIL / ADMIN_PASSWORD.
 * Runs on every boot so that changing the environment variables and
 * redeploying is a supported way to recover a lost password.
 *
 * @returns {Promise<'created'|'updated'|null>}
 */
export async function bootstrapAdmin() {
  if (!config.adminEmail || !config.adminPassword) return null;

  const passwordHash = await bcrypt.hash(config.adminPassword, 10);
  const existing = get('SELECT id, role FROM users WHERE email = :email', {
    email: config.adminEmail
  });

  if (existing) {
    run(
      `UPDATE users
          SET password_hash = :passwordHash,
              role          = 'admin',
              is_active     = 1
        WHERE id = :id`,
      { passwordHash, id: existing.id }
    );
    return 'updated';
  }

  run(
    `INSERT INTO users (name, email, password_hash, role, department)
     VALUES (:name, :email, :passwordHash, 'admin', 'Administration')`,
    { name: config.adminName, email: config.adminEmail, passwordHash }
  );
  return 'created';
}

/**
 * Fill an empty database with demo data.
 *
 * Outside production this happens automatically, so a fresh clone just works.
 * In production it requires SEED_DEMO_DATA, because the demo accounts share a
 * password that is written down in the README.
 *
 * @returns {Promise<'seeded'|'skipped-production'|'not-needed'>}
 */
export async function seedIfEmpty() {
  if (userCount() > 0) return 'not-needed';

  if (config.isProduction && !config.seedDemoData) return 'skipped-production';

  await seedDatabase({ quiet: true });

  if (userCount() === 0) {
    throw new Error('Seeding reported success but wrote no accounts.');
  }
  return 'seeded';
}

export { userCount };

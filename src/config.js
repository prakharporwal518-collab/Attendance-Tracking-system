import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repository root, used to resolve every relative path in the config. */
export const rootDir = path.resolve(__dirname, '..');

const resolveFromRoot = (value) =>
  path.isAbsolute(value) ? value : path.join(rootDir, value);

const isProduction = process.env.NODE_ENV === 'production';

const jwtSecret = process.env.JWT_SECRET ?? 'dev-only-insecure-secret';

if (isProduction && jwtSecret === 'dev-only-insecure-secret') {
  throw new Error(
    'JWT_SECRET must be set to a unique value when NODE_ENV=production.'
  );
}

const asBoolean = (value) => ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());

export const config = {
  isProduction,
  port: Number(process.env.PORT ?? 3000),
  jwtSecret,
  tokenExpiresIn: process.env.TOKEN_EXPIRES_IN ?? '8h',
  databaseFile: resolveFromRoot(process.env.DATABASE_FILE ?? 'data/attendance.sqlite'),
  seedPassword: process.env.SEED_PASSWORD ?? 'password123',
  publicDir: path.join(rootDir, 'public'),

  // Hosts such as Render set NODE_ENV=production for you and give you no shell
  // to run a seed command in, so demo data has to be requestable by env var.
  seedDemoData: asBoolean(process.env.SEED_DEMO_DATA),

  // The supported way to get a real, non-demo login into a deployed instance.
  // Applied on every boot, so it also survives a host with an ephemeral disk
  // and doubles as password recovery: change the value and redeploy.
  adminEmail: process.env.ADMIN_EMAIL?.trim().toLowerCase() || null,
  adminPassword: process.env.ADMIN_PASSWORD || null,
  adminName: process.env.ADMIN_NAME?.trim() || 'Administrator',

  // Render, Heroku and friends terminate TLS in front of the app.
  trustProxy: asBoolean(process.env.TRUST_PROXY ?? (isProduction ? 'true' : 'false'))
};

/**
 * ADMIN_EMAIL / ADMIN_PASSWORD are optional. A mistake in them should not take
 * the whole site down — the app still has its other accounts — so these warn
 * and switch the bootstrap off rather than refusing to start. JWT_SECRET above
 * stays fatal, because running with a guessable signing key is not a degraded
 * mode, it is an insecure one.
 */
const adminProblem =
  config.adminEmail && !config.adminPassword
    ? 'ADMIN_EMAIL is set but ADMIN_PASSWORD is missing.'
    : config.adminPassword && !config.adminEmail
      ? 'ADMIN_PASSWORD is set but ADMIN_EMAIL is missing.'
      : config.adminPassword && config.adminPassword.length < 8
        ? 'ADMIN_PASSWORD is shorter than 8 characters.'
        : null;

if (adminProblem) {
  console.warn(`
  ${adminProblem}
  No administrator will be created from those variables. Set both
  ADMIN_EMAIL and ADMIN_PASSWORD (8+ characters) and redeploy.
`);
  config.adminEmail = null;
  config.adminPassword = null;
}

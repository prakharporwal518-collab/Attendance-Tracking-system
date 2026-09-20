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

export const config = {
  isProduction,
  port: Number(process.env.PORT ?? 3000),
  jwtSecret,
  tokenExpiresIn: process.env.TOKEN_EXPIRES_IN ?? '8h',
  databaseFile: resolveFromRoot(process.env.DATABASE_FILE ?? 'data/attendance.sqlite'),
  seedPassword: process.env.SEED_PASSWORD ?? 'password123',
  publicDir: path.join(rootDir, 'public')
};

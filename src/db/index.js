// Must come first: it explains an old Node version before the import below
// fails with a message that does not mention Node versions at all.
import '../utils/requirements.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A DATABASE_FILE pointing somewhere the process cannot write is a common
// deployment mistake — typically a path on a disk that was never mounted.
// The raw errno that follows says nothing about which path or why.
const databaseDir = path.dirname(config.databaseFile);

try {
  fs.mkdirSync(databaseDir, { recursive: true });
  fs.accessSync(databaseDir, fs.constants.W_OK);
} catch (error) {
  console.error(`
  Cannot write the database to:
    ${config.databaseFile}

  The directory ${databaseDir} is not writable (${error.code ?? error.message}).

  If DATABASE_FILE points at a mounted disk, check that the disk exists and
  that its mount path matches. On hosts whose plan has no disks, leave
  DATABASE_FILE unset so the database is stored inside the project instead.
`);
  process.exit(1);
}

export const db = new DatabaseSync(config.databaseFile);

// WAL keeps reads fast while a write is in flight; the foreign-key pragma is
// off by default in SQLite and every table below relies on it.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

/** Run a query and return every row. */
export function all(sql, params = {}) {
  return db.prepare(sql).all(params);
}

/** Run a query and return the first row, or undefined. */
export function get(sql, params = {}) {
  return db.prepare(sql).get(params);
}

/** Run a statement and return { changes, lastInsertRowid }. */
export function run(sql, params = {}) {
  return db.prepare(sql).run(params);
}

/** Wrap `fn` in a transaction so a partial failure rolls everything back. */
export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

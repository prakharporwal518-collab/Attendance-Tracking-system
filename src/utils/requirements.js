/**
 * Checked before anything imports `node:sqlite`, which this project stores all
 * of its data in.
 *
 * Version numbers alone are not enough to decide whether it is usable.
 * `node:sqlite` was added in Node 22.5, but until 22.13 it was hidden behind
 * the `--experimental-sqlite` flag, so on 22.5–22.12 the import fails with
 * "No such built-in module: node:sqlite" no matter what the version check
 * said. So ask Node directly instead of guessing from the version.
 *
 * Import this module FIRST wherever the database is loaded — ES module
 * imports are evaluated in the order they are written.
 */
const MINIMUM = '22.13.0';

/** True when `node:sqlite` can actually be loaded in this process. */
function sqliteAvailable() {
  // Added in Node 22.3, so it exists on every version that could plausibly
  // have node:sqlite. Guarded anyway, since older versions reach this code.
  if (typeof process.getBuiltinModule === 'function') {
    try {
      return Boolean(process.getBuiltinModule('node:sqlite'));
    } catch {
      return false;
    }
  }
  return false;
}

if (!sqliteAvailable()) {
  console.error(`
  This project cannot start on Node ${process.versions.node}.

  It stores its data using Node's built-in SQLite support, which is only
  available without a command-line flag from Node ${MINIMUM} onwards.
  Node 22.5 to 22.12 report "No such built-in module: node:sqlite".

  Use Node ${MINIMUM} or newer:

    Deploying (Render, Railway…)  set NODE_VERSION to 22.22.2
    Windows / macOS               install the LTS build from https://nodejs.org
    nvm                           nvm install 22.22.2 && nvm use 22.22.2

  Check which version you are on with:  node --version
`);
  process.exit(1);
}

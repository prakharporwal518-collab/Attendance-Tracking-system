/**
 * Checked before anything imports `node:sqlite`, which only exists from
 * Node 22.5 onwards. Without this the failure is `Cannot find module
 * 'node:sqlite'`, which does not tell you that your Node is simply too old.
 *
 * Import this module FIRST wherever the database is loaded — ES module
 * imports run in the order they are written.
 */
const REQUIRED_MAJOR = 22;
const REQUIRED_MINOR = 5;

const [major, minor] = process.versions.node.split('.').map(Number);
const tooOld = major < REQUIRED_MAJOR || (major === REQUIRED_MAJOR && minor < REQUIRED_MINOR);

if (tooOld) {
  console.error(`
  This project needs Node ${REQUIRED_MAJOR}.${REQUIRED_MINOR} or newer.
  You are running Node ${process.versions.node}.

  It uses Node's built-in SQLite support, which was added in 22.5.

  To upgrade:
    Windows / macOS   download the LTS installer from https://nodejs.org
    nvm users         nvm install 22 && nvm use 22

  Check your version at any time with:  node --version
`);
  process.exit(1);
}

/**
 * Deployment behaviour: what a hosted instance does on first boot, where
 * NODE_ENV=production is set for you and there is no shell to run commands in.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-deploy-'));
process.env.DATABASE_FILE = path.join(tempDir, 'deploy.sqlite');
process.env.JWT_SECRET = 'a-long-secret-for-this-test';
process.env.NODE_ENV = 'production';
process.env.ADMIN_EMAIL = 'Owner@Example.COM';
process.env.ADMIN_PASSWORD = 'first-password';

const { config } = await import('../src/config.js');
const { createApp } = await import('../src/app.js');
const { bootstrapAdmin, ensureStarterData, userCount, hasDemoAccounts } =
  await import('../src/db/bootstrap.js');
const { get, run } = await import('../src/db/index.js');

let baseUrl;
let server;

const login = (email, password) =>
  fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('a production deploy', () => {
  it('does not create demo accounts on its own', async () => {
    assert.equal(config.isProduction, true);
    assert.equal(config.seedDemoData, false);
    assert.equal(await ensureStarterData(), 'skipped-production');
    assert.equal(userCount(), 0);
  });

  it('trusts the TLS-terminating proxy by default', () => {
    assert.equal(config.trustProxy, true);
  });

  it('creates the administrator from ADMIN_EMAIL / ADMIN_PASSWORD', async () => {
    assert.equal(await bootstrapAdmin(), 'created');
    assert.equal(userCount(), 1);

    // The address is stored lowercased, whatever case the env var used.
    const admin = get("SELECT email, role FROM users WHERE role = 'admin'");
    assert.equal(admin.email, 'owner@example.com');
  });

  it('lets that administrator sign in, case-insensitively', async () => {
    const response = await login('OWNER@example.com', 'first-password');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.role, 'admin');
  });

  it('re-applies the password on every boot, so it can be recovered', async () => {
    config.adminPassword = 'second-password';
    assert.equal(await bootstrapAdmin(), 'updated');

    assert.equal((await login('owner@example.com', 'first-password')).status, 401);
    assert.equal((await login('owner@example.com', 'second-password')).status, 200);

    // Still one account: recovery updates, it does not add a duplicate.
    assert.equal(userCount(), 1);
    config.adminPassword = 'first-password';
    await bootstrapAdmin();
  });

  it('restores a deactivated administrator rather than locking you out', async () => {
    run("UPDATE users SET is_active = 0 WHERE email = 'owner@example.com'");
    assert.equal((await login('owner@example.com', 'first-password')).status, 401);

    await bootstrapAdmin();
    assert.equal((await login('owner@example.com', 'first-password')).status, 200);
  });

  it('does not advertise demo logins that are not installed', async () => {
    assert.equal(hasDemoAccounts(), false);

    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json();
    assert.equal(body.setupRequired, false);
    assert.equal(body.demoAccounts, false);
  });

  it('loads demo data alongside an existing administrator', async () => {
    // The admin created above means the database is not empty. Keying the
    // demo seed off emptiness made SEED_DEMO_DATA a no-op forever after.
    assert.ok(userCount() > 0);

    config.seedDemoData = true;
    assert.equal(await ensureStarterData(), 'seeded');

    assert.equal(hasDemoAccounts(), true);
    assert.equal((await login('sunita.rao@college.edu', 'password123')).status, 200);
    assert.equal((await login('admin@college.edu', 'password123')).status, 200);
  });

  it('keeps the administrator working after the demo data is added', async () => {
    assert.equal((await login('owner@example.com', 'first-password')).status, 200);
  });

  it('now reports the demo logins as available', async () => {
    const body = await (await fetch(`${baseUrl}/api/health`)).json();
    assert.equal(body.demoAccounts, true);
  });

  it('does not seed a second time', async () => {
    const before = userCount();
    assert.equal(await ensureStarterData(), 'not-needed');
    assert.equal(userCount(), before);
    config.seedDemoData = false;
  });
});

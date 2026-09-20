/**
 * First-run behaviour: what a fresh clone sees before any data exists.
 * This runs in its own process so it can have a genuinely empty database.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-setup-'));
process.env.DATABASE_FILE = path.join(tempDir, 'empty.sqlite');
process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

const { createApp } = await import('../src/app.js');
const { get } = await import('../src/db/index.js');

let baseUrl;
let server;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('an empty database', () => {
  it('starts with no users', () => {
    assert.equal(get('SELECT COUNT(*) AS n FROM users').n, 0);
  });

  it('reports that setup is required', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.setupRequired, true);
  });

  it('explains itself instead of blaming the password', async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@college.edu', password: 'password123' })
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.match(body.error, /No accounts exist yet/);
    assert.doesNotMatch(body.error, /incorrect/);
  });
});

describe('seeding', () => {
  it('creates the documented demo accounts, and is a no-op the second time', async () => {
    const { seedDatabase } = await import('../src/db/seed.js');

    assert.equal(await seedDatabase({ quiet: true }), true);

    const bcrypt = (await import('bcryptjs')).default;
    const expected = [
      ['admin@college.edu', 'admin'],
      ['sunita.rao@college.edu', 'teacher'],
      ['aarav.sharma1@student.college.edu', 'student']
    ];

    for (const [email, role] of expected) {
      const user = get('SELECT role, password_hash FROM users WHERE email = :email', { email });
      assert.ok(user, `${email} should exist after seeding`);
      assert.equal(user.role, role);
      assert.ok(
        await bcrypt.compare('password123', user.password_hash),
        `${email} should accept the documented password`
      );
    }

    // Running it again must not duplicate anything.
    assert.equal(await seedDatabase({ quiet: true }), false);
  });

  it('lets the seeded admin sign in', async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@college.edu', password: 'password123' })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.role, 'admin');
  });
});

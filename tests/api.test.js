/**
 * End-to-end tests against a real server backed by a throwaway database.
 * Run with: npm test
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the app at a temporary database before anything imports the config.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-test-'));
process.env.DATABASE_FILE = path.join(tempDir, 'test.sqlite');
process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

const { createApp } = await import('../src/app.js');
const { run, get } = await import('../src/db/index.js');
const bcrypt = (await import('bcryptjs')).default;

let baseUrl;
let server;

/** Sign in and return a fetch wrapper that carries the session cookie. */
async function signIn(email, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.equal(response.status, 200, `login failed for ${email}`);

  const { token } = await response.json();

  return async (method, path, body) => {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  };
}

const today = () => {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
};

let admin;
let teacher;
let student;
let courseId;
let studentIds;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const hash = await bcrypt.hash('password123', 10);
  const makeUser = (name, email, role, roll = null) =>
    Number(
      run(
        `INSERT INTO users (name, email, password_hash, role, roll_number)
         VALUES (:name, :email, :hash, :role, :roll)`,
        { name, email, hash, role, roll }
      ).lastInsertRowid
    );

  makeUser('Admin', 'admin@test.edu', 'admin');
  const teacherId = makeUser('Teacher One', 'teacher@test.edu', 'teacher');
  makeUser('Teacher Two', 'other@test.edu', 'teacher');
  studentIds = [
    makeUser('Student A', 'a@test.edu', 'student', 'R001'),
    makeUser('Student B', 'b@test.edu', 'student', 'R002')
  ];

  courseId = Number(
    run(
      `INSERT INTO courses (code, name, teacher_id) VALUES ('T101', 'Testing 101', :teacherId)`,
      { teacherId }
    ).lastInsertRowid
  );
  for (const id of studentIds) {
    run('INSERT INTO enrollments (course_id, student_id) VALUES (:courseId, :id)', { courseId, id });
  }

  admin = await signIn('admin@test.edu', 'password123');
  teacher = await signIn('teacher@test.edu', 'password123');
  student = await signIn('a@test.edu', 'password123');
});

after(() => {
  server?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('authentication', () => {
  it('rejects a wrong password', async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@test.edu', password: 'nope' })
    });
    assert.equal(response.status, 401);
  });

  it('rejects an unknown email with the same message as a wrong password', async () => {
    const unknown = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ghost@test.edu', password: 'password123' })
    });
    assert.equal(unknown.status, 401);
    assert.match((await unknown.json()).error, /incorrect/);
  });

  it('refuses requests without a token', async () => {
    const response = await fetch(`${baseUrl}/api/courses`);
    assert.equal(response.status, 401);
  });

  it('returns the signed-in user', async () => {
    const { status, body } = await admin('GET', '/auth/me');
    assert.equal(status, 200);
    assert.equal(body.user.role, 'admin');
  });
});

describe('role permissions', () => {
  it('stops a student reading the user list', async () => {
    assert.equal((await student('GET', '/users')).status, 403);
  });

  it('stops a teacher creating accounts', async () => {
    const { status } = await teacher('POST', '/users', {
      name: 'X', email: 'x@test.edu', role: 'student', password: 'password123'
    });
    assert.equal(status, 403);
  });

  it('lets the owning teacher open the marking sheet', async () => {
    const { status, body } = await teacher('GET', `/attendance/sheet?courseId=${courseId}`);
    assert.equal(status, 200);
    assert.equal(body.students.length, 2);
  });

  it('stops a different teacher opening that sheet', async () => {
    const other = await signIn('other@test.edu', 'password123');
    const { status } = await other('GET', `/attendance/sheet?courseId=${courseId}`);
    assert.equal(status, 403);
  });

  it('stops a student reading another student’s report', async () => {
    const { status } = await student('GET', `/reports/student/${studentIds[1]}`);
    assert.equal(status, 403);
  });
});

describe('marking attendance', () => {
  it('saves a sheet', async () => {
    const { status, body } = await teacher('POST', '/attendance/bulk', {
      courseId,
      date: today(),
      records: [
        { studentId: studentIds[0], status: 'present' },
        { studentId: studentIds[1], status: 'absent', note: 'Unwell' }
      ]
    });
    assert.equal(status, 200);
    assert.equal(body.saved, 2);
  });

  it('overwrites rather than duplicating when the same date is saved again', async () => {
    await teacher('POST', '/attendance/bulk', {
      courseId,
      date: today(),
      records: [{ studentId: studentIds[0], status: 'late' }]
    });

    const rows = get(
      `SELECT COUNT(*) AS n FROM attendance
        WHERE course_id = :courseId AND student_id = :studentId AND session_date = :date`,
      { courseId, studentId: studentIds[0], date: today() }
    );
    assert.equal(rows.n, 1);

    const { body } = await teacher('GET', `/attendance?courseId=${courseId}`);
    const record = body.records.find((row) => row.studentId === studentIds[0]);
    assert.equal(record.status, 'late');
  });

  it('refuses a future date', async () => {
    const { status, body } = await teacher('POST', '/attendance/bulk', {
      courseId, date: '2099-01-01', records: [{ studentId: studentIds[0], status: 'present' }]
    });
    assert.equal(status, 400);
    assert.match(body.error, /future/);
  });

  it('refuses a date that does not exist', async () => {
    const { status } = await teacher('POST', '/attendance/bulk', {
      courseId, date: '2026-02-31', records: [{ studentId: studentIds[0], status: 'present' }]
    });
    assert.equal(status, 400);
  });

  it('refuses an unknown status', async () => {
    const { status } = await teacher('POST', '/attendance/bulk', {
      courseId, date: today(), records: [{ studentId: studentIds[0], status: 'maybe' }]
    });
    assert.equal(status, 400);
  });

  it('refuses a student who is not enrolled', async () => {
    const { status, body } = await teacher('POST', '/attendance/bulk', {
      courseId, date: today(), records: [{ studentId: 9999, status: 'present' }]
    });
    assert.equal(status, 400);
    assert.match(body.error, /not enrolled/);
  });
});

describe('scoping', () => {
  it('shows a student only their own records', async () => {
    const { body } = await student('GET', '/attendance');
    const owners = new Set(body.records.map((row) => row.studentId));
    assert.equal(owners.size, 1);
    assert.ok(owners.has(studentIds[0]));
  });

  it('shows a teacher only the courses they teach', async () => {
    const other = await signIn('other@test.edu', 'password123');
    assert.equal((await other('GET', '/courses')).body.courses.length, 0);
    assert.equal((await teacher('GET', '/courses')).body.courses.length, 1);
  });
});

describe('users', () => {
  it('rejects a duplicate email', async () => {
    const { status } = await admin('POST', '/users', {
      name: 'Copy', email: 'a@test.edu', role: 'student', password: 'password123'
    });
    assert.equal(status, 409);
  });

  it('rejects a short password', async () => {
    const { status } = await admin('POST', '/users', {
      name: 'Weak', email: 'weak@test.edu', role: 'student', password: 'abc'
    });
    assert.equal(status, 400);
  });

  it('stops an admin locking themselves out', async () => {
    const me = (await admin('GET', '/auth/me')).body.user;
    assert.equal((await admin('PATCH', `/users/${me.id}`, { isActive: false })).status, 400);
    assert.equal((await admin('DELETE', `/users/${me.id}`)).status, 400);
  });

  it('blocks a deactivated account from signing in', async () => {
    const created = (await admin('POST', '/users', {
      name: 'Temp', email: 'temp@test.edu', role: 'student', password: 'password123'
    })).body.user;

    await admin('PATCH', `/users/${created.id}`, { isActive: false });

    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'temp@test.edu', password: 'password123' })
    });
    assert.equal(response.status, 401);
    assert.match((await response.json()).error, /deactivated/);
  });
});

describe('reports', () => {
  it('computes an attendance rate that excludes excused sessions', async () => {
    const extraCourse = (await admin('POST', '/courses', { code: 'T102', name: 'Rates' })).body.course;
    await admin('POST', `/courses/${extraCourse.id}/students`, { studentIds: [studentIds[0]] });

    // 2 present, 1 absent, 1 excused  ->  2 / 3 = 66.7%
    const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];
    const statuses = ['present', 'present', 'absent', 'excused'];
    for (let i = 0; i < dates.length; i++) {
      await admin('POST', '/attendance/bulk', {
        courseId: extraCourse.id,
        date: dates[i],
        records: [{ studentId: studentIds[0], status: statuses[i] }]
      });
    }

    const { body } = await admin(`GET`, `/reports/course/${extraCourse.id}`);
    assert.equal(body.students[0].rate, 66.7);
    assert.equal(body.sessions.length, 4);
  });

  it('exports CSV with a header row', async () => {
    const { status, body } = await admin('GET', `/reports/export.csv?courseId=${courseId}`);
    assert.equal(status, 200);
    assert.ok(String(body).startsWith('Date,Course Code'));
  });
});

describe('cascades and validation', () => {
  it('removes attendance when a course is deleted', async () => {
    const course = (await admin('POST', '/courses', { code: 'T199', name: 'Doomed' })).body.course;
    await admin('POST', `/courses/${course.id}/students`, { studentIds: [studentIds[0]] });
    await admin('POST', '/attendance/bulk', {
      courseId: course.id, date: today(), records: [{ studentId: studentIds[0], status: 'present' }]
    });

    const before = get('SELECT COUNT(*) AS n FROM attendance WHERE course_id = :id', { id: course.id });
    assert.equal(before.n, 1);

    await admin('DELETE', `/courses/${course.id}`);

    const after = get('SELECT COUNT(*) AS n FROM attendance WHERE course_id = :id', { id: course.id });
    assert.equal(after.n, 0);
  });

  it('rejects a malformed id', async () => {
    assert.equal((await admin('GET', '/courses/abc')).status, 400);
  });

  it('404s an unknown course', async () => {
    assert.equal((await admin('GET', '/courses/99999')).status, 404);
  });

  it('404s an unknown API path', async () => {
    assert.equal((await admin('GET', '/nope')).status, 404);
  });
});

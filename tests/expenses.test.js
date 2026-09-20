/**
 * The expense tracker, end to end against a real server and a throwaway
 * database. Run with: npm test
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expenses-test-'));
process.env.DATABASE_FILE = path.join(tempDir, 'test.sqlite');
process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';
process.env.CURRENCY = 'INR';

const { createApp } = await import('../src/app.js');
const { run } = await import('../src/db/index.js');
const { parseAmount, formatAmount } = await import('../src/utils/money.js');
const bcrypt = (await import('bcryptjs')).default;

let baseUrl;
let server;

async function signIn(email, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.equal(response.status, 200, `login failed for ${email}`);

  const { token } = await response.json();

  return async (method, apiPath, body) => {
    const res = await fetch(`${baseUrl}/api${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const text = await res.text();
    let json;
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
let otherTeacher;
let student;
let courseId;
let labId;
let travelId;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const hash = await bcrypt.hash('password123', 10);
  const makeUser = (name, email, role) =>
    Number(
      run(
        `INSERT INTO users (name, email, password_hash, role) VALUES (:name, :email, :hash, :role)`,
        { name, email, hash, role }
      ).lastInsertRowid
    );

  makeUser('Admin', 'admin@test.edu', 'admin');
  const teacherId = makeUser('Teacher One', 'teacher@test.edu', 'teacher');
  makeUser('Teacher Two', 'other@test.edu', 'teacher');
  makeUser('Student A', 'a@test.edu', 'student');

  courseId = Number(
    run("INSERT INTO courses (code, name, teacher_id) VALUES ('T101', 'Testing 101', :teacherId)", {
      teacherId
    }).lastInsertRowid
  );

  admin = await signIn('admin@test.edu', 'password123');
  teacher = await signIn('teacher@test.edu', 'password123');
  otherTeacher = await signIn('other@test.edu', 'password123');
  student = await signIn('a@test.edu', 'password123');

  labId = (
    await admin('POST', '/expenses/categories', {
      name: 'Lab Equipment',
      monthlyBudget: '1000.00',
      description: 'Kit for the labs'
    })
  ).body.category.id;

  travelId = (await admin('POST', '/expenses/categories', { name: 'Travel' })).body.category.id;
});

after(() => {
  server?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('money parsing', () => {
  it('reads decimals exactly, without floating point drift', () => {
    assert.equal(parseAmount('19.99'), 1999);
    assert.equal(parseAmount(19.99), 1999);
    assert.equal(parseAmount('0.01'), 1);
    assert.equal(parseAmount('1250'), 125000);
    assert.equal(formatAmount(parseAmount('1250.5')), '1250.50');
  });

  it('refuses anything that is not a plain positive amount', () => {
    for (const bad of ['', '-5', '1,250', '1.234', 'abc', 0, null, Infinity]) {
      assert.throws(() => parseAmount(bad), /amount/i, `accepted ${JSON.stringify(bad)}`);
    }
  });

  it('formats an overspend with its sign', () => {
    assert.equal(formatAmount(-12345), '-123.45');
    assert.equal(formatAmount(0), '0.00');
  });
});

describe('access control', () => {
  it('keeps students out of the ledger entirely', async () => {
    for (const [method, route] of [
      ['GET', '/expenses'],
      ['GET', '/expenses/summary'],
      ['GET', '/expenses/categories'],
      ['POST', '/expenses']
    ]) {
      const response = await student(method, route, method === 'POST' ? {} : undefined);
      assert.equal(response.status, 403, `${method} ${route}`);
    }
  });

  it('lets only administrators manage categories', async () => {
    const response = await teacher('POST', '/expenses/categories', { name: 'Nope' });
    assert.equal(response.status, 403);
  });

  it('requires a signed-in user', async () => {
    const response = await fetch(`${baseUrl}/api/expenses`);
    assert.equal(response.status, 401);
  });
});

describe('categories', () => {
  it('rejects a duplicate name regardless of case', async () => {
    const response = await admin('POST', '/expenses/categories', { name: 'lab equipment' });
    assert.equal(response.status, 409);
  });

  it('stores a budget in minor units and hands back a decimal string', async () => {
    const { body } = await admin('GET', '/expenses/categories');
    const lab = body.categories.find((category) => category.id === labId);
    assert.equal(lab.budgetMinor, 100000);
    assert.equal(lab.budget, '1000.00');
    assert.equal(body.currency, 'INR');
  });

  it('allows a category with no budget at all', async () => {
    const { body } = await admin('GET', `/expenses/categories`);
    const travel = body.categories.find((category) => category.id === travelId);
    assert.equal(travel.budgetMinor, null);
    assert.equal(travel.budget, null);
  });

  it('refuses to delete a category that is in use', async () => {
    const created = await admin('POST', '/expenses', {
      title: 'Temporary',
      amount: '10',
      categoryId: travelId
    });
    assert.equal(created.status, 201);

    const blocked = await admin('DELETE', `/expenses/categories/${travelId}`);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /still has 1 expense/);

    await admin('DELETE', `/expenses/${created.body.expense.id}`);
    assert.equal((await admin('DELETE', `/expenses/categories/${travelId}`)).status, 200);

    // Put it back for the tests that follow.
    travelId = (await admin('POST', '/expenses/categories', { name: 'Travel' })).body.category.id;
  });
});

describe('recording an expense', () => {
  it('starts as pending when a teacher raises it', async () => {
    const { status, body } = await teacher('POST', '/expenses', {
      title: 'Soldering irons',
      amount: '249.50',
      categoryId: labId,
      courseId,
      vendor: 'Nova Instruments'
    });

    assert.equal(status, 201);
    assert.equal(body.expense.status, 'pending');
    assert.equal(body.expense.amountMinor, 24950);
    assert.equal(body.expense.amount, '249.50');
    assert.equal(body.expense.courseCode, 'T101');
    assert.equal(body.expense.createdByName, 'Teacher One');
    assert.equal(body.expense.reviewedById, null);
  });

  it('is approved on the spot when an administrator raises it', async () => {
    const { body } = await admin('POST', '/expenses', {
      title: 'Server rack',
      amount: '500',
      categoryId: labId
    });
    assert.equal(body.expense.status, 'approved');
    assert.equal(body.expense.reviewedByName, 'Admin');
  });

  it('defaults the date to today', async () => {
    const { body } = await admin('POST', '/expenses', {
      title: 'Cables',
      amount: '12.34',
      categoryId: labId
    });
    assert.equal(body.expense.spentOn, today());
  });

  it('will not let a teacher choose the status', async () => {
    const response = await teacher('POST', '/expenses', {
      title: 'Self approved',
      amount: '10',
      categoryId: labId,
      status: 'approved'
    });
    assert.equal(response.status, 403);
  });

  it('validates the amount, the category and the date', async () => {
    const cases = [
      [{ title: 'x', amount: '0', categoryId: labId }, /greater than zero/],
      [{ title: 'x', amount: '1.005', categoryId: labId }, /positive amount/],
      [{ title: 'x', amount: '-3', categoryId: labId }, /positive amount/],
      [{ title: '', amount: '5', categoryId: labId }, /"title" is required/],
      [{ title: 'x', amount: '5', categoryId: 9999 }, /does not exist/],
      [{ title: 'x', amount: '5', categoryId: labId, spentOn: '2026-02-31' }, /real calendar date/],
      [{ title: 'x', amount: '5', categoryId: labId, spentOn: '1994-01-01' }, /on or after/],
      [{ title: 'x', amount: '5', categoryId: labId, spentOn: '2199-01-01' }, /future/],
      [{ title: 'x', amount: '5', categoryId: labId, courseId: 4242 }, /course does not exist/]
    ];

    for (const [payload, pattern] of cases) {
      const response = await admin('POST', '/expenses', payload);
      assert.equal(response.status, 400, JSON.stringify(payload));
      assert.match(response.body.error, pattern);
    }
  });

  it('will not book against a deactivated category', async () => {
    const { body } = await admin('POST', '/expenses/categories', { name: 'Retired head' });
    await admin('PATCH', `/expenses/categories/${body.category.id}`, { isActive: false });

    const response = await teacher('POST', '/expenses', {
      title: 'Too late',
      amount: '10',
      categoryId: body.category.id
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /no longer active/);
  });
});

describe('approval', () => {
  let expenseId;

  before(async () => {
    const { body } = await teacher('POST', '/expenses', {
      title: 'Workshop banner',
      amount: '80.25',
      categoryId: labId
    });
    expenseId = body.expense.id;
  });

  it('records who approved it and when', async () => {
    const { status, body } = await admin('PATCH', `/expenses/${expenseId}/status`, {
      status: 'approved'
    });
    assert.equal(status, 200);
    assert.equal(body.expense.status, 'approved');
    assert.equal(body.expense.reviewedByName, 'Admin');
    assert.ok(body.expense.reviewedAt);
  });

  it('clears the reviewer when sent back to pending', async () => {
    const { body } = await admin('PATCH', `/expenses/${expenseId}/status`, { status: 'pending' });
    assert.equal(body.expense.reviewedById, null);
    assert.equal(body.expense.reviewedAt, null);
  });

  it('is closed to teachers', async () => {
    const response = await teacher('PATCH', `/expenses/${expenseId}/status`, { status: 'approved' });
    assert.equal(response.status, 403);
  });

  it('can also be changed through a plain patch, reviewer and all', async () => {
    const { status, body } = await admin('PATCH', `/expenses/${expenseId}`, {
      status: 'rejected',
      note: 'No purchase order.'
    });

    assert.equal(status, 200);
    assert.equal(body.expense.status, 'rejected');
    assert.equal(body.expense.note, 'No purchase order.');
    assert.equal(body.expense.reviewedByName, 'Admin');
    assert.ok(body.expense.reviewedAt);
  });

  it('rejects an unknown status', async () => {
    const response = await admin('PATCH', `/expenses/${expenseId}/status`, { status: 'maybe' });
    assert.equal(response.status, 400);
  });
});

describe('what a teacher may touch', () => {
  let mine;

  before(async () => {
    const { body } = await teacher('POST', '/expenses', {
      title: 'Mine only',
      amount: '15',
      categoryId: labId
    });
    mine = body.expense.id;
  });

  it('hides one teacher\'s expenses from another', async () => {
    const response = await otherTeacher('GET', `/expenses/${mine}`);
    assert.equal(response.status, 403);

    const list = await otherTeacher('GET', '/expenses');
    assert.ok(list.body.expenses.every((expense) => expense.title !== 'Mine only'));
  });

  it('lets the owner edit it while it is still pending', async () => {
    const { status, body } = await teacher('PATCH', `/expenses/${mine}`, { amount: '18.75' });
    assert.equal(status, 200);
    assert.equal(body.expense.amountMinor, 1875);
  });

  it('locks it once it has been approved', async () => {
    await admin('PATCH', `/expenses/${mine}/status`, { status: 'approved' });

    const edit = await teacher('PATCH', `/expenses/${mine}`, { amount: '999' });
    assert.equal(edit.status, 409);

    const remove = await teacher('DELETE', `/expenses/${mine}`);
    assert.equal(remove.status, 409);

    // The administrator is still free to correct it.
    assert.equal((await admin('PATCH', `/expenses/${mine}`, { amount: '20' })).status, 200);
  });

  it('refuses an empty patch', async () => {
    const response = await admin('PATCH', `/expenses/${mine}`, {});
    assert.equal(response.status, 400);
    assert.match(response.body.error, /No changes/);
  });
});

describe('filtering and totals', () => {
  before(async () => {
    // A tidy, known set of amounts in one category on known dates.
    const rows = [
      ['Printer paper 50% off', '19.99', '2026-01-05'],
      ['Ink cartridge', '0.01', '2026-01-06'],
      ['Chairs', '100.00', '2026-02-10']
    ];
    for (const [title, amount, spentOn] of rows) {
      const response = await admin('POST', '/expenses', {
        title,
        amount,
        spentOn,
        categoryId: travelId,
        vendor: 'Campus Stationers'
      });
      assert.equal(response.status, 201, response.body.error);
    }
  });

  it('adds decimals up exactly', async () => {
    const { body } = await admin('GET', '/expenses?from=2026-01-01&to=2026-01-31&categoryId=' + travelId);
    // 19.99 + 0.01 is 20.00, not 19.999999999999996.
    assert.equal(body.totals.totalMinor, 2000);
    assert.equal(body.totals.count, 2);
  });

  it('filters by date range and category together', async () => {
    const { body } = await admin('GET', `/expenses?from=2026-02-01&to=2026-02-28&categoryId=${travelId}`);
    assert.equal(body.expenses.length, 1);
    assert.equal(body.expenses[0].title, 'Chairs');
  });

  it('rejects a backwards date range', async () => {
    const response = await admin('GET', '/expenses?from=2026-05-01&to=2026-01-01');
    assert.equal(response.status, 400);
  });

  it('treats a % in the search box as text, not a wildcard', async () => {
    const everything = await admin('GET', '/expenses');
    assert.ok(everything.body.totals.count > 1);

    // Unescaped, "%" is LIKE's match-anything and would return every row.
    const wildcard = await admin('GET', '/expenses?q=%25');
    assert.equal(wildcard.status, 200);
    assert.equal(wildcard.body.expenses.length, 1);
    assert.equal(wildcard.body.expenses[0].title, 'Printer paper 50% off');

    const literal = await admin('GET', '/expenses?q=50%25%20off');
    assert.equal(literal.body.expenses.length, 1);
    assert.equal(literal.body.expenses[0].title, 'Printer paper 50% off');
  });

  it('treats an underscore as text too', async () => {
    const response = await admin('GET', '/expenses?q=_hairs');
    assert.equal(response.status, 200);
    // "_" would match any single character, and so would find "Chairs".
    assert.equal(response.body.expenses.length, 0);
  });

  it('searches the vendor as well as the title', async () => {
    const { body } = await admin('GET', '/expenses?q=Campus');
    assert.equal(body.expenses.length, 3);
  });

  it('paginates, and says whether there is more', async () => {
    const first = await admin('GET', '/expenses?limit=2&offset=0');
    assert.equal(first.body.expenses.length, 2);
    assert.equal(first.body.hasMore, true);

    const far = await admin('GET', `/expenses?limit=2&offset=${first.body.totals.count}`);
    assert.equal(far.body.expenses.length, 0);
    assert.equal(far.body.hasMore, false);
  });

  it('caps an absurd page size instead of reading the whole table', async () => {
    const { body } = await admin('GET', '/expenses?limit=999999');
    assert.equal(body.limit, 500);
  });

  it('rejects a nonsense limit or offset', async () => {
    assert.equal((await admin('GET', '/expenses?limit=0')).status, 400);
    assert.equal((await admin('GET', '/expenses?limit=abc')).status, 400);
    assert.equal((await admin('GET', '/expenses?offset=-1')).status, 400);
  });
});

describe('the monthly summary', () => {
  it('reports budget usage for the month asked for', async () => {
    const { status, body } = await admin('GET', '/expenses/summary?month=2026-01');

    assert.equal(status, 200);
    assert.equal(body.month, '2026-01');
    assert.equal(body.scope, 'all');
    assert.equal(body.totals.approvedMinor, 2000);

    const travel = body.byCategory.find((row) => row.id === travelId);
    assert.equal(travel.approvedMinor, 2000);
    assert.equal(travel.budgetMinor, null);
    assert.equal(travel.usage, null);

    const lab = body.byCategory.find((row) => row.id === labId);
    assert.equal(lab.budgetMinor, 100000);
    assert.equal(lab.approvedMinor, 0);
    assert.equal(lab.remainingMinor, 100000);
  });

  it('turns spending into a usage percentage', async () => {
    const created = await admin('POST', '/expenses', {
      title: 'Half the budget',
      amount: '500',
      categoryId: labId,
      spentOn: '2026-03-04'
    });
    assert.equal(created.status, 201);

    const { body } = await admin('GET', '/expenses/summary?month=2026-03');
    const lab = body.byCategory.find((row) => row.id === labId);
    assert.equal(lab.usage, 50);
    assert.equal(lab.remainingMinor, 50000);
  });

  it('always charts twelve months, gaps included', async () => {
    const { body } = await admin('GET', '/expenses/summary?month=2026-03');
    assert.equal(body.byMonth.length, 12);
    assert.equal(body.byMonth.at(-1).month, '2026-03');
    assert.equal(body.byMonth[0].month, '2025-04');
    assert.ok(body.byMonth.every((row) => typeof row.approvedMinor === 'number'));
  });

  it('rolls the year over correctly at a December boundary', async () => {
    const { body } = await admin('GET', '/expenses/summary?month=2025-12');
    assert.equal(body.byMonth.at(-1).month, '2025-12');
    assert.equal(body.byMonth[0].month, '2025-01');
  });

  it('shows a teacher only their own numbers', async () => {
    const { body } = await teacher('GET', '/expenses/summary?month=2026-01');
    assert.equal(body.scope, 'own');
    assert.equal(body.totals.approvedMinor, 0);
  });

  it('rejects a malformed month', async () => {
    for (const month of ['2026-13', '2026-1', 'January', '2026']) {
      const response = await admin(`GET`, `/expenses/summary?month=${encodeURIComponent(month)}`);
      assert.equal(response.status, 400, month);
    }
  });
});

describe('CSV export', () => {
  it('writes a header and plain decimal amounts', async () => {
    const { status, body } = await admin(
      'GET',
      `/expenses/export.csv?from=2026-01-01&to=2026-01-31&categoryId=${travelId}`
    );

    assert.equal(status, 200);
    const lines = body.split('\r\n');
    assert.equal(lines[0], 'Date,Title,Amount (INR),Category,Course,Vendor,Status,Note,Recorded By,Reviewed By');
    assert.equal(lines.length, 3);
    // A comma-free decimal, so a spreadsheet reads the column as a number.
    assert.ok(lines.some((line) => line.includes(',19.99,')));
  });

  it('quotes a title containing a comma', async () => {
    const created = await admin('POST', '/expenses', {
      title: 'Pens, pencils and erasers',
      amount: '5',
      categoryId: travelId,
      spentOn: '2026-04-01'
    });
    assert.equal(created.status, 201);

    const { body } = await admin('GET', '/expenses/export.csv?from=2026-04-01&to=2026-04-01');
    assert.ok(body.includes('"Pens, pencils and erasers"'));
  });

  it('gives a teacher only their own rows', async () => {
    const { body } = await teacher('GET', '/expenses/export.csv?from=2026-01-01&to=2026-04-30');
    assert.equal(body.split('\r\n').length, 1, 'only the header should remain');
  });
});

describe('unknown records', () => {
  it('answers 404 rather than crashing', async () => {
    assert.equal((await admin('GET', '/expenses/999999')).status, 404);
    assert.equal((await admin('PATCH', '/expenses/999999', { amount: '1' })).status, 404);
    assert.equal((await admin('DELETE', '/expenses/999999')).status, 404);
    assert.equal((await admin('GET', '/expenses/not-a-number')).status, 400);
  });
});

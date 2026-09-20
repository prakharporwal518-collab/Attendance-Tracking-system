/**
 * The expense tracker: spending heads with monthly budgets, the expenses
 * booked against them, and a small approval flow.
 *
 * Administrators see and manage the whole ledger. Teachers raise expenses and
 * see their own. Students have no access at all — the router-level role guard
 * below is the single place that decides that.
 */
import { Router } from 'express';
import { all, get, run } from '../db/index.js';
import { config } from '../config.js';
import { authenticate, requireRoles } from '../middleware/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { amountFields, formatAmount, optionalAmount, parseAmount } from '../utils/money.js';
import {
  optionalDate,
  optionalId,
  optionalLimit,
  optionalMonth,
  optionalOffset,
  optionalString,
  requireDate,
  requireExpenseStatus,
  requireId,
  requireString,
  today
} from '../utils/validate.js';

export const expensesRouter = Router();

expensesRouter.use(authenticate);
expensesRouter.use(requireRoles('admin', 'teacher'));

const isAdmin = (user) => user.role === 'admin';

/* ------------------------------------------------------------- categories */

const SELECT_CATEGORY = `
  SELECT cat.id,
         cat.name,
         cat.description,
         cat.monthly_budget AS budgetMinor,
         cat.is_active      AS isActive,
         cat.created_at     AS createdAt,
         (SELECT COUNT(*) FROM expenses e WHERE e.category_id = cat.id) AS expenseCount
    FROM expense_categories cat`;

const shapeCategory = (row) => ({
  ...row,
  isActive: row.isActive === 1,
  budget: row.budgetMinor === null ? null : formatAmount(row.budgetMinor)
});

function loadCategory(id) {
  const category = get(`${SELECT_CATEGORY} WHERE cat.id = :id`, { id });
  if (!category) throw notFound('Expense category not found.');
  return shapeCategory(category);
}

expensesRouter.get('/categories', (_req, res) => {
  res.json({
    currency: config.currency,
    categories: all(`${SELECT_CATEGORY} ORDER BY cat.name`).map(shapeCategory)
  });
});

expensesRouter.post('/categories', requireRoles('admin'), (req, res) => {
  const name = requireString(req.body?.name, 'name', { max: 80 });
  const description = optionalString(req.body?.description, 'description', { max: 300 });
  const budgetMinor = optionalAmount(req.body?.monthlyBudget, 'monthlyBudget', { allowZero: true });

  if (get('SELECT id FROM expense_categories WHERE name = :name', { name })) {
    throw conflict('A category with that name already exists.');
  }

  const { lastInsertRowid } = run(
    `INSERT INTO expense_categories (name, description, monthly_budget)
     VALUES (:name, :description, :budgetMinor)`,
    { name, description, budgetMinor }
  );

  res.status(201).json({ category: loadCategory(Number(lastInsertRowid)) });
});

expensesRouter.patch('/categories/:id', requireRoles('admin'), (req, res) => {
  const id = requireId(req.params.id);
  loadCategory(id);

  const updates = {};

  if (req.body?.name !== undefined) {
    const name = requireString(req.body.name, 'name', { max: 80 });
    if (get('SELECT id FROM expense_categories WHERE name = :name AND id != :id', { name, id })) {
      throw conflict('Another category already uses that name.');
    }
    updates.name = name;
  }
  if (req.body?.description !== undefined) {
    updates.description = optionalString(req.body.description, 'description', { max: 300 });
  }
  if (req.body?.monthlyBudget !== undefined) {
    updates.monthly_budget = optionalAmount(req.body.monthlyBudget, 'monthlyBudget', {
      allowZero: true
    });
  }
  if (req.body?.isActive !== undefined) {
    if (typeof req.body.isActive !== 'boolean') {
      throw badRequest('"isActive" must be true or false.');
    }
    updates.is_active = req.body.isActive ? 1 : 0;
  }

  if (Object.keys(updates).length === 0) throw badRequest('No changes were provided.');

  const assignments = Object.keys(updates).map((column) => `${column} = :${column}`).join(', ');
  run(`UPDATE expense_categories SET ${assignments} WHERE id = :id`, { ...updates, id });

  res.json({ category: loadCategory(id) });
});

expensesRouter.delete('/categories/:id', requireRoles('admin'), (req, res) => {
  const id = requireId(req.params.id);
  const category = loadCategory(id);

  // The foreign key would stop this anyway, but a 409 explaining the way out
  // beats "FOREIGN KEY constraint failed".
  if (category.expenseCount > 0) {
    throw conflict(
      `"${category.name}" still has ${category.expenseCount} expense(s). ` +
        'Move them to another category, or deactivate this one instead.'
    );
  }

  run('DELETE FROM expense_categories WHERE id = :id', { id });
  res.json({ ok: true });
});

/* --------------------------------------------------------------- expenses */

const SELECT_EXPENSE = `
  SELECT e.id,
         e.title,
         e.amount        AS amountMinor,
         e.spent_on      AS spentOn,
         e.category_id   AS categoryId,
         cat.name        AS categoryName,
         e.course_id     AS courseId,
         c.code          AS courseCode,
         c.name          AS courseName,
         e.vendor,
         e.note,
         e.status,
         e.created_by    AS createdById,
         cu.name         AS createdByName,
         e.reviewed_by   AS reviewedById,
         ru.name         AS reviewedByName,
         e.reviewed_at   AS reviewedAt,
         e.created_at    AS createdAt,
         e.updated_at    AS updatedAt
    FROM expenses e
    JOIN expense_categories cat ON cat.id = e.category_id
    LEFT JOIN courses c  ON c.id  = e.course_id
    LEFT JOIN users   cu ON cu.id = e.created_by
    LEFT JOIN users   ru ON ru.id = e.reviewed_by`;

const shapeExpense = (row) => ({ ...row, ...amountFields(row.amountMinor) });

/** Teachers only ever see what they raised themselves. */
const canSee = (user, expense) => isAdmin(user) || expense.createdById === user.id;

function loadExpense(id, user) {
  const expense = get(`${SELECT_EXPENSE} WHERE e.id = :id`, { id });
  if (!expense) throw notFound('Expense not found.');
  if (!canSee(user, expense)) throw forbidden('You can only view expenses you recorded.');
  return shapeExpense(expense);
}

/**
 * Turn the query string into a WHERE clause plus its parameters.
 *
 * node:sqlite rejects named parameters that the statement does not mention, so
 * every key here is added only when its clause is.
 */
function buildFilters(req) {
  const clauses = [];
  const params = {};

  if (!isAdmin(req.user)) {
    clauses.push('e.created_by = :selfId');
    params.selfId = req.user.id;
  }

  const categoryId = optionalId(req.query.categoryId, 'categoryId');
  if (categoryId) {
    clauses.push('e.category_id = :categoryId');
    params.categoryId = categoryId;
  }

  const courseId = optionalId(req.query.courseId, 'courseId');
  if (courseId) {
    clauses.push('e.course_id = :courseId');
    params.courseId = courseId;
  }

  if (req.query.status !== undefined && req.query.status !== '') {
    clauses.push('e.status = :status');
    params.status = requireExpenseStatus(req.query.status);
  }

  const from = optionalDate(req.query.from, 'from');
  const to = optionalDate(req.query.to, 'to');
  if (from && to && from > to) {
    throw badRequest('"from" must not be after "to".');
  }
  if (from) {
    clauses.push('e.spent_on >= :from');
    params.from = from;
  }
  if (to) {
    clauses.push('e.spent_on <= :to');
    params.to = to;
  }

  const search = optionalString(req.query.q, 'q', { max: 100 });
  if (search) {
    clauses.push(`(e.title LIKE :search ESCAPE '\\'
                OR IFNULL(e.vendor, '') LIKE :search ESCAPE '\\'
                OR IFNULL(e.note, '')   LIKE :search ESCAPE '\\')`);
    // % and _ are wildcards; a search for "50%" should not match everything.
    params.search = `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  }

  return { where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

expensesRouter.get('/', (req, res) => {
  const { where, params } = buildFilters(req);
  const limit = optionalLimit(req.query.limit);
  const offset = optionalOffset(req.query.offset);

  const expenses = all(
    `${SELECT_EXPENSE} ${where}
      ORDER BY e.spent_on DESC, e.id DESC
      LIMIT :limit OFFSET :offset`,
    { ...params, limit, offset }
  ).map(shapeExpense);

  const totals = get(
    `SELECT COUNT(*) AS count,
            IFNULL(SUM(e.amount), 0)                                          AS totalMinor,
            IFNULL(SUM(CASE WHEN e.status = 'approved' THEN e.amount END), 0) AS approvedMinor,
            IFNULL(SUM(CASE WHEN e.status = 'pending'  THEN e.amount END), 0) AS pendingMinor
       FROM expenses e ${where}`,
    params
  );

  res.json({
    currency: config.currency,
    expenses,
    totals,
    limit,
    offset,
    // So the client knows there is another page without a second request.
    hasMore: offset + expenses.length < totals.count
  });
});


/** The filtered ledger as a spreadsheet, honouring the same query string. */
expensesRouter.get('/export.csv', (req, res) => {
  const { where, params } = buildFilters(req);

  const rows = all(
    `${SELECT_EXPENSE} ${where} ORDER BY e.spent_on DESC, e.id DESC LIMIT 5000`,
    params
  );

  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };

  const header = [
    'Date', 'Title', `Amount (${config.currency})`, 'Category', 'Course',
    'Vendor', 'Status', 'Note', 'Recorded By', 'Reviewed By'
  ];

  const csv = [
    header.join(','),
    ...rows.map((row) =>
      [
        row.spentOn,
        row.title,
        // A plain decimal, not a formatted one: thousands separators and
        // currency symbols stop a spreadsheet reading the column as a number.
        amountFields(row.amountMinor).amount,
        row.categoryName,
        row.courseCode ?? '',
        row.vendor ?? '',
        row.status,
        row.note ?? '',
        row.createdByName ?? '',
        row.reviewedByName ?? ''
      ]
        .map(escape)
        .join(',')
    )
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="expenses-${Date.now()}.csv"`);
  res.send(csv);
});

/* ---------------------------------------------------------------- summary */

/** "2026-09" -> "2026-10", and December rolls the year over. */
function nextMonth(month) {
  const [year, index] = month.split('-').map(Number);
  return index === 12
    ? `${year + 1}-01`
    : `${year}-${String(index + 1).padStart(2, '0')}`;
}

/** `count` months ending at `month`, oldest first. */
function monthsEndingAt(month, count) {
  const months = [month];
  while (months.length < count) {
    const [year, index] = months[0].split('-').map(Number);
    months.unshift(
      index === 1 ? `${year - 1}-12` : `${year}-${String(index - 1).padStart(2, '0')}`
    );
  }
  return months;
}

const MONTHS_CHARTED = 12;

expensesRouter.get('/summary', (req, res) => {
  const month = optionalMonth(req.query.month) ?? today().slice(0, 7);
  const scoped = isAdmin(req.user) ? '' : ' AND e.created_by = :selfId';
  const scopeParams = isAdmin(req.user) ? {} : { selfId: req.user.id };

  const start = `${month}-01`;
  const end = `${nextMonth(month)}-01`;

  const TOTALS = `
    COUNT(e.id)                                                        AS count,
    IFNULL(SUM(CASE WHEN e.status = 'approved' THEN e.amount END), 0)  AS approvedMinor,
    IFNULL(SUM(CASE WHEN e.status = 'pending'  THEN e.amount END), 0)  AS pendingMinor,
    IFNULL(SUM(CASE WHEN e.status = 'rejected' THEN e.amount END), 0)  AS rejectedMinor`;

  const totals = get(
    `SELECT ${TOTALS}
       FROM expenses e
      WHERE e.spent_on >= :start AND e.spent_on < :end ${scoped}`,
    { start, end, ...scopeParams }
  );

  const byCategory = all(
    `SELECT cat.id,
            cat.name,
            cat.monthly_budget AS budgetMinor,
            ${TOTALS}
       FROM expense_categories cat
       LEFT JOIN expenses e
              ON e.category_id = cat.id
             AND e.spent_on >= :start
             AND e.spent_on < :end ${scoped}
      WHERE cat.is_active = 1
      GROUP BY cat.id
      ORDER BY cat.name`,
    { start, end, ...scopeParams }
  ).map((row) => ({
    ...row,
    // Only approved spending counts against a budget; pending is shown apart.
    usage:
      row.budgetMinor === null || row.budgetMinor === 0
        ? null
        : Math.round((row.approvedMinor / row.budgetMinor) * 1000) / 10,
    remainingMinor: row.budgetMinor === null ? null : row.budgetMinor - row.approvedMinor
  }));

  const charted = monthsEndingAt(month, MONTHS_CHARTED);
  const rows = all(
    `SELECT substr(e.spent_on, 1, 7) AS month, ${TOTALS}
       FROM expenses e
      WHERE e.spent_on >= :chartStart AND e.spent_on < :end ${scoped}
      GROUP BY month
      ORDER BY month`,
    { chartStart: `${charted[0]}-01`, end, ...scopeParams }
  );

  // Fill the gaps so a quiet month is a zero bar rather than a missing one.
  const found = new Map(rows.map((row) => [row.month, row]));
  const byMonth = charted.map(
    (name) =>
      found.get(name) ?? {
        month: name,
        count: 0,
        approvedMinor: 0,
        pendingMinor: 0,
        rejectedMinor: 0
      }
  );

  const recent = all(
    `${SELECT_EXPENSE} ${isAdmin(req.user) ? '' : 'WHERE e.created_by = :selfId'}
      ORDER BY e.spent_on DESC, e.id DESC
      LIMIT 5`,
    scopeParams
  ).map(shapeExpense);

  const budgetedMinor = byCategory.reduce((total, row) => total + (row.budgetMinor ?? 0), 0);

  res.json({
    currency: config.currency,
    month,
    scope: isAdmin(req.user) ? 'all' : 'own',
    totals,
    budgetedMinor,
    byCategory,
    byMonth,
    recent
  });
});

/* ------------------------------------------------------------------ write */

const EARLIEST_SPEND_DATE = '2000-01-01';

/** A year from today, as YYYY-MM-DD — the far edge of a plausible spend date. */
function latestSpendDate() {
  const [year, month, day] = today().split('-').map(Number);
  return `${year + 1}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Guard against a mistyped year turning every report into nonsense. */
function checkSpendDate(spentOn) {
  if (spentOn < EARLIEST_SPEND_DATE) {
    throw badRequest(`"spentOn" must be on or after ${EARLIEST_SPEND_DATE}.`);
  }
  if (spentOn > latestSpendDate()) {
    throw badRequest('"spentOn" is more than a year in the future — check the year.');
  }
  return spentOn;
}

function checkCategory(categoryId, { mustBeActive }) {
  const category = get('SELECT id, name, is_active AS isActive FROM expense_categories WHERE id = :categoryId', {
    categoryId
  });
  if (!category) throw badRequest('That expense category does not exist.');
  if (mustBeActive && category.isActive !== 1) {
    throw badRequest(`The "${category.name}" category is no longer active.`);
  }
  return category;
}

function checkCourse(courseId) {
  if (courseId === null) return null;
  const course = get('SELECT id FROM courses WHERE id = :courseId', { courseId });
  if (!course) throw badRequest('That course does not exist.');
  return course;
}

expensesRouter.post('/', (req, res) => {
  const title = requireString(req.body?.title, 'title');
  const amount = parseAmount(req.body?.amount);
  const spentOn = checkSpendDate(
    req.body?.spentOn === undefined || req.body?.spentOn === ''
      ? today()
      : requireDate(req.body.spentOn, 'spentOn')
  );
  const categoryId = requireId(req.body?.categoryId, 'categoryId');
  const courseId = optionalId(req.body?.courseId, 'courseId');
  const vendor = optionalString(req.body?.vendor, 'vendor', { max: 120 });
  const note = optionalString(req.body?.note, 'note', { max: 500 });

  checkCategory(categoryId, { mustBeActive: true });
  checkCourse(courseId);

  // An administrator recording their own spend does not need to approve it
  // afterwards; anything a teacher raises waits for review.
  let status = isAdmin(req.user) ? 'approved' : 'pending';
  if (req.body?.status !== undefined) {
    if (!isAdmin(req.user)) throw forbidden('Only an administrator can set the status.');
    status = requireExpenseStatus(req.body.status);
  }

  const reviewed = status === 'pending' ? null : req.user.id;

  const { lastInsertRowid } = run(
    `INSERT INTO expenses
       (title, amount, spent_on, category_id, course_id, vendor, note, status,
        created_by, reviewed_by, reviewed_at)
     VALUES
       (:title, :amount, :spentOn, :categoryId, :courseId, :vendor, :note, :status,
        :createdBy, :reviewed, ${reviewed === null ? 'NULL' : "datetime('now')"})`,
    {
      title,
      amount,
      spentOn,
      categoryId,
      courseId,
      vendor,
      note,
      status,
      createdBy: req.user.id,
      reviewed
    }
  );

  res.status(201).json({ expense: loadExpense(Number(lastInsertRowid), req.user) });
});

expensesRouter.get('/:id', (req, res) => {
  res.json({
    currency: config.currency,
    expense: loadExpense(requireId(req.params.id), req.user)
  });
});

expensesRouter.patch('/:id', (req, res) => {
  const id = requireId(req.params.id);
  const expense = loadExpense(id, req.user);

  // Once an expense has been reviewed, changing its amount behind the
  // approver's back would make the approval meaningless.
  if (!isAdmin(req.user) && expense.status !== 'pending') {
    throw conflict(`This expense has been ${expense.status} and can no longer be edited.`);
  }

  const updates = {};

  if (req.body?.title !== undefined) updates.title = requireString(req.body.title, 'title');
  if (req.body?.amount !== undefined) updates.amount = parseAmount(req.body.amount);
  if (req.body?.spentOn !== undefined) {
    updates.spent_on = checkSpendDate(requireDate(req.body.spentOn, 'spentOn'));
  }
  if (req.body?.categoryId !== undefined) {
    const categoryId = requireId(req.body.categoryId, 'categoryId');
    // Moving an expense onto a category that was retired is fine for an
    // admin tidying up, but a teacher should not pick one from the form.
    checkCategory(categoryId, { mustBeActive: !isAdmin(req.user) });
    updates.category_id = categoryId;
  }
  if (req.body?.courseId !== undefined) {
    const courseId = optionalId(req.body.courseId, 'courseId');
    checkCourse(courseId);
    updates.course_id = courseId;
  }
  if (req.body?.vendor !== undefined) {
    updates.vendor = optionalString(req.body.vendor, 'vendor', { max: 120 });
  }
  if (req.body?.note !== undefined) {
    updates.note = optionalString(req.body.note, 'note', { max: 500 });
  }
  if (req.body?.status !== undefined) {
    if (!isAdmin(req.user)) throw forbidden('Only an administrator can change the status.');
    updates.status = requireExpenseStatus(req.body.status);
    // Whoever changes the status becomes the reviewer of record, in the same
    // statement — a status that outlived its reviewer would be a lie.
    updates.reviewed_by = updates.status === 'pending' ? null : req.user.id;
  }

  if (Object.keys(updates).length === 0) throw badRequest('No changes were provided.');

  const assignments = Object.keys(updates).map((column) => `${column} = :${column}`).join(', ');
  const reviewedAt =
    updates.status === undefined
      ? ''
      : `, reviewed_at = ${updates.status === 'pending' ? 'NULL' : "datetime('now')"}`;

  run(
    `UPDATE expenses
        SET ${assignments}${reviewedAt}, updated_at = datetime('now')
      WHERE id = :id`,
    { ...updates, id }
  );

  res.json({ expense: loadExpense(id, req.user) });
});

/** Approve or reject — the one action that is administrator-only. */
expensesRouter.patch('/:id/status', requireRoles('admin'), (req, res) => {
  const id = requireId(req.params.id);
  loadExpense(id, req.user);

  const status = requireExpenseStatus(req.body?.status);

  run(
    `UPDATE expenses
        SET status      = :status,
            reviewed_by = :reviewedBy,
            reviewed_at = ${status === 'pending' ? 'NULL' : "datetime('now')"},
            updated_at  = datetime('now')
      WHERE id = :id`,
    { status, reviewedBy: status === 'pending' ? null : req.user.id, id }
  );

  res.json({ expense: loadExpense(id, req.user) });
});

expensesRouter.delete('/:id', (req, res) => {
  const id = requireId(req.params.id);
  const expense = loadExpense(id, req.user);

  if (!isAdmin(req.user) && expense.status !== 'pending') {
    throw conflict(`This expense has been ${expense.status} and can no longer be deleted.`);
  }

  run('DELETE FROM expenses WHERE id = :id', { id });
  res.json({ ok: true });
});

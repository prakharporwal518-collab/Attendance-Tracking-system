import { api } from '../api.js';
import {
  $,
  $$,
  confirmAction,
  emptyState,
  esc,
  formatDate,
  openModal,
  toast,
  today
} from '../ui.js';

const PAGE_SIZE = 25;

/**
 * Amounts arrive as integer minor units. Dividing by 100 only ever happens
 * here, at the last moment before display, so no total is ever carried around
 * as a float.
 */
function makeMoney(currency) {
  let formatter = null;
  try {
    formatter = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2
    });
  } catch {
    // An unknown CURRENCY code would otherwise throw on every single row.
    formatter = null;
  }

  return (minor) => {
    const value = Number(minor ?? 0) / 100;
    return formatter ? formatter.format(value) : `${currency} ${value.toFixed(2)}`;
  };
}

/** "2026-09" -> "September 2026" */
function formatMonth(month) {
  const date = new Date(`${month}-01T00:00:00`);
  if (Number.isNaN(date.getTime())) return month;
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

const currentMonth = () => today().slice(0, 7);

const statusBadge = (status) => `<span class="badge expense-${esc(status)}">${esc(status)}</span>`;

/** Budget usage bar. Unlike attendance, a high number is the bad one here. */
function usageBar(usage) {
  if (usage === null || usage === undefined) {
    return '<span class="muted small">No budget set</span>';
  }
  const tone = usage > 100 ? 'bad' : usage > 85 ? 'warn' : '';
  return `
    <div class="rate">
      <div class="bar ${tone}"><span style="width:${Math.max(0, Math.min(100, usage))}%"></span></div>
      <span class="num">${usage.toFixed(1)}%</span>
    </div>`;
}

/** A twelve-month column chart, drawn with plain divs. */
function trendChart(byMonth, money) {
  const peak = Math.max(...byMonth.map((row) => row.approvedMinor + row.pendingMinor), 1);

  return `
    <div class="spark">
      ${byMonth
        .map((row) => {
          const total = row.approvedMinor + row.pendingMinor;
          const height = Math.round((total / peak) * 100);
          return `
            <div class="spark-col" title="${esc(formatMonth(row.month))} — ${esc(money(total))}">
              <div class="spark-bar" style="height:${Math.max(total > 0 ? 4 : 1, height)}%"></div>
              <span class="spark-label">${esc(row.month.slice(5))}</span>
            </div>`;
        })
        .join('')}
    </div>`;
}

/* ------------------------------------------------------------- the screen */

export async function expensesView(container, { user, params }) {
  const isAdmin = user.role === 'admin';

  const [{ categories, currency }, { courses }] = await Promise.all([
    api.get('/expenses/categories'),
    api.get('/courses')
  ]);

  const money = makeMoney(currency);

  const state = {
    month: params.get('month') ?? currentMonth(),
    categoryId: params.get('categoryId') ?? '',
    status: params.get('status') ?? '',
    q: '',
    from: '',
    to: '',
    offset: 0
  };

  container.innerHTML = `
    <div id="exp-summary"></div>

    <div class="card">
      <div class="card-header">
        <h2>Budgets</h2>
        <div class="spacer"></div>
        <input id="exp-month" type="month" value="${esc(state.month)}" aria-label="Budget month" />
      </div>
      <div id="exp-budgets" class="card-body flush"><div class="loading">Loading…</div></div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2>Expenses</h2>
        <div class="spacer"></div>
        ${isAdmin ? '<button class="btn ghost small" id="exp-categories">Categories</button>' : ''}
        <button class="btn ghost small" id="exp-export">Export CSV</button>
        <button class="btn small" id="exp-new">+ Record expense</button>
      </div>
      <div class="card-body">
        <div class="toolbar">
          <div class="field" style="flex:1">
            <label for="exp-search">Search</label>
            <input id="exp-search" type="search" placeholder="Title, vendor or note" />
          </div>
          <div class="field">
            <label for="exp-category">Category</label>
            <select id="exp-category">
              <option value="">All categories</option>
              ${categories
                .map(
                  (category) =>
                    `<option value="${category.id}" ${
                      String(category.id) === state.categoryId ? 'selected' : ''
                    }>${esc(category.name)}</option>`
                )
                .join('')}
            </select>
          </div>
          <div class="field">
            <label for="exp-status">Status</label>
            <select id="exp-status">
              ${['', 'pending', 'approved', 'rejected']
                .map(
                  (value) =>
                    `<option value="${value}" ${value === state.status ? 'selected' : ''}>${
                      value === '' ? 'Any status' : value[0].toUpperCase() + value.slice(1)
                    }</option>`
                )
                .join('')}
            </select>
          </div>
          <div class="field">
            <label for="exp-from">From</label>
            <input id="exp-from" type="date" />
          </div>
          <div class="field">
            <label for="exp-to">To</label>
            <input id="exp-to" type="date" />
          </div>
          <button class="btn" id="exp-apply">Apply</button>
          <button class="btn ghost" id="exp-clear">Clear</button>
        </div>
      </div>
      <div id="exp-list" class="card-body flush"><div class="loading">Loading…</div></div>
    </div>`;

  const summaryBox = $('#exp-summary', container);
  const budgetsBox = $('#exp-budgets', container);
  const listBox = $('#exp-list', container);

  const activeCategories = () => categories.filter((category) => category.isActive);

  /** The filters as a query string, shared by the table and the CSV export. */
  const listQuery = (extra = {}) =>
    api.query({
      categoryId: state.categoryId,
      status: state.status,
      q: state.q,
      from: state.from,
      to: state.to,
      ...extra
    });

  /* ------------------------------------------------------------ summary */

  async function loadSummary() {
    let data;
    try {
      data = await api.get(`/expenses/summary${api.query({ month: state.month })}`);
    } catch (error) {
      summaryBox.innerHTML = `<div class="alert error">${esc(error.message)}</div>`;
      budgetsBox.innerHTML = '';
      return;
    }

    const { totals, byCategory, byMonth, budgetedMinor } = data;
    const usage = budgetedMinor > 0
      ? Math.round((totals.approvedMinor / budgetedMinor) * 1000) / 10
      : null;

    summaryBox.innerHTML = `
      <div class="stat-grid">
        <div class="stat">
          <div class="label">Approved · ${esc(formatMonth(data.month))}</div>
          <div class="value" style="font-size:1.5rem">${esc(money(totals.approvedMinor))}</div>
          <div class="hint">${data.scope === 'own' ? 'Expenses you recorded' : 'Across the institution'}</div>
        </div>
        <div class="stat">
          <div class="label">Awaiting approval</div>
          <div class="value" style="font-size:1.5rem">${esc(money(totals.pendingMinor))}</div>
          <div class="hint"><a href="#/expenses?status=pending">Review pending</a></div>
        </div>
        <div class="stat">
          <div class="label">Budget used</div>
          <div class="value" style="font-size:1.5rem">${usage === null ? '—' : `${usage.toFixed(1)}%`}</div>
          <div class="hint">of ${esc(money(budgetedMinor))} budgeted</div>
        </div>
        <div class="stat">
          <div class="label">Entries this month</div>
          <div class="value" style="font-size:1.5rem">${totals.count}</div>
          <div class="hint">${esc(money(totals.rejectedMinor))} rejected</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h2>Last 12 months</h2>
          <div class="spacer"></div>
          <span class="muted small">approved and pending, by month</span>
        </div>
        <div class="card-body">${trendChart(byMonth, money)}</div>
      </div>`;

    if (!byCategory.length) {
      budgetsBox.innerHTML = emptyState(
        isAdmin
          ? 'No active categories yet — add one from the Categories button below.'
          : 'No active expense categories have been set up yet.',
        '🗂️'
      );
      return;
    }

    budgetsBox.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Category</th>
              <th class="right">Monthly budget</th>
              <th class="right">Approved</th>
              <th class="right">Pending</th>
              <th class="right">Remaining</th>
              <th style="min-width:160px">Used</th>
            </tr>
          </thead>
          <tbody>
            ${byCategory
              .map(
                (row) => `
              <tr>
                <td><strong>${esc(row.name)}</strong><div class="muted small">${row.count} entr${
                  row.count === 1 ? 'y' : 'ies'
                }</div></td>
                <td class="right">${row.budgetMinor === null ? '<span class="muted">—</span>' : esc(money(row.budgetMinor))}</td>
                <td class="right">${esc(money(row.approvedMinor))}</td>
                <td class="right">${row.pendingMinor > 0 ? esc(money(row.pendingMinor)) : '<span class="muted">—</span>'}</td>
                <td class="right ${row.remainingMinor !== null && row.remainingMinor < 0 ? 'over' : ''}">${
                  row.remainingMinor === null ? '<span class="muted">—</span>' : esc(money(row.remainingMinor))
                }</td>
                <td>${usageBar(row.usage)}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>`;
  }

  /* --------------------------------------------------------------- list */

  async function loadList() {
    listBox.innerHTML = '<div class="loading">Loading…</div>';

    let data;
    try {
      data = await api.get(
        `/expenses${listQuery({ limit: PAGE_SIZE, offset: state.offset })}`
      );
    } catch (error) {
      listBox.innerHTML = `<div class="card-body"><div class="alert error">${esc(error.message)}</div></div>`;
      return;
    }

    const { expenses, totals } = data;

    if (!expenses.length) {
      listBox.innerHTML =
        state.offset > 0
          ? emptyState('No more expenses on this page.', '📄')
          : emptyState('No expenses match these filters yet.', '🧾');
      return;
    }

    const first = state.offset + 1;
    const last = state.offset + expenses.length;

    listBox.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Expense</th>
              <th>Category</th>
              <th>Course</th>
              <th class="right">Amount</th>
              <th>Status</th>
              <th>Recorded by</th>
              <th class="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${expenses.map((expense) => rowHtml(expense)).join('')}
          </tbody>
        </table>
      </div>
      <div class="table-foot">
        <span class="muted small">
          Showing ${first}–${last} of ${totals.count} ·
          ${esc(money(totals.totalMinor))} total
          (${esc(money(totals.approvedMinor))} approved, ${esc(money(totals.pendingMinor))} pending)
        </span>
        <div class="spacer"></div>
        <button class="btn ghost small" data-page="prev" ${state.offset === 0 ? 'disabled' : ''}>Previous</button>
        <button class="btn ghost small" data-page="next" ${data.hasMore ? '' : 'disabled'}>Next</button>
      </div>`;
  }

  function rowHtml(expense) {
    const canEdit = isAdmin || expense.status === 'pending';

    return `
      <tr>
        <td class="nowrap">${esc(formatDate(expense.spentOn))}</td>
        <td>
          <strong>${esc(expense.title)}</strong>
          ${expense.vendor ? `<div class="muted small">${esc(expense.vendor)}</div>` : ''}
          ${expense.note ? `<div class="muted small">${esc(expense.note)}</div>` : ''}
        </td>
        <td>${esc(expense.categoryName)}</td>
        <td>${expense.courseCode ? esc(expense.courseCode) : '<span class="muted">—</span>'}</td>
        <td class="right nowrap"><strong>${esc(money(expense.amountMinor))}</strong></td>
        <td>${statusBadge(expense.status)}</td>
        <td class="nowrap">${esc(expense.createdByName ?? '—')}</td>
        <td class="right nowrap">
          ${
            isAdmin && expense.status !== 'approved'
              ? `<button class="btn small" data-approve="${expense.id}">Approve</button>`
              : ''
          }
          ${
            isAdmin && expense.status === 'pending'
              ? `<button class="btn ghost small" data-reject="${expense.id}">Reject</button>`
              : ''
          }
          ${canEdit ? `<button class="btn ghost small" data-edit="${expense.id}">Edit</button>` : ''}
          ${canEdit ? `<button class="btn danger small" data-delete="${expense.id}">Delete</button>` : ''}
        </td>
      </tr>`;
  }

  async function refresh() {
    await Promise.all([loadSummary(), loadList()]);
  }

  /* -------------------------------------------------------- the edit form */

  function expenseForm(expense) {
    // An inactive category is kept as an option when the expense already uses
    // it, so that editing an old row does not silently move it elsewhere.
    const options = activeCategories();
    if (expense && !options.some((category) => category.id === expense.categoryId)) {
      const current = categories.find((category) => category.id === expense.categoryId);
      if (current) options.unshift(current);
    }

    return `
      <div id="exp-form-error" class="alert error hidden"></div>
      <form id="exp-form" novalidate>
        <div class="field">
          <label for="f-title">What was it for</label>
          <input id="f-title" name="title" required maxlength="200"
                 value="${esc(expense?.title ?? '')}" placeholder="e.g. Projector lamp replacement" />
        </div>
        <div class="grid-2">
          <div class="field">
            <label for="f-amount">Amount (${esc(currency)})</label>
            <input id="f-amount" name="amount" type="number" step="0.01" min="0.01" required
                   value="${esc(expense?.amount ?? '')}" placeholder="0.00" />
          </div>
          <div class="field">
            <label for="f-date">Date of spend</label>
            <input id="f-date" name="spentOn" type="date" required
                   value="${esc(expense?.spentOn ?? today())}" />
          </div>
        </div>
        <div class="grid-2">
          <div class="field">
            <label for="f-category">Category</label>
            <select id="f-category" name="categoryId" required>
              ${options
                .map(
                  (category) =>
                    `<option value="${category.id}" ${
                      category.id === expense?.categoryId ? 'selected' : ''
                    }>${esc(category.name)}${category.isActive ? '' : ' (inactive)'}</option>`
                )
                .join('')}
            </select>
          </div>
          <div class="field">
            <label for="f-course">Course (optional)</label>
            <select id="f-course" name="courseId">
              <option value="">Not course specific</option>
              ${courses
                .map(
                  (course) =>
                    `<option value="${course.id}" ${
                      course.id === expense?.courseId ? 'selected' : ''
                    }>${esc(course.code)} — ${esc(course.name)}</option>`
                )
                .join('')}
            </select>
          </div>
        </div>
        <div class="field">
          <label for="f-vendor">Paid to (optional)</label>
          <input id="f-vendor" name="vendor" maxlength="120" value="${esc(expense?.vendor ?? '')}" />
        </div>
        <div class="field">
          <label for="f-note">Note (optional)</label>
          <textarea id="f-note" name="note" rows="2" maxlength="500">${esc(expense?.note ?? '')}</textarea>
        </div>
      </form>`;
  }

  function openExpenseModal(expense = null) {
    if (!activeCategories().length && !expense) {
      toast('Add an expense category first.', 'error');
      return;
    }

    openModal({
      title: expense ? 'Edit expense' : 'Record an expense',
      body: expenseForm(expense),
      footer: `
        <button class="btn ghost" data-close>Cancel</button>
        <button class="btn" data-save>${expense ? 'Save changes' : 'Record expense'}</button>`,
      onMount(modal, close) {
        const errorBox = $('#exp-form-error', modal);
        const form = $('#exp-form', modal);
        const saveButton = $('[data-save]', modal);

        const save = async () => {
          const payload = {
            title: $('#f-title', modal).value.trim(),
            amount: $('#f-amount', modal).value.trim(),
            spentOn: $('#f-date', modal).value,
            categoryId: $('#f-category', modal).value,
            courseId: $('#f-course', modal).value,
            vendor: $('#f-vendor', modal).value.trim(),
            note: $('#f-note', modal).value.trim()
          };

          if (!payload.title) {
            errorBox.textContent = 'Give the expense a short title.';
            errorBox.classList.remove('hidden');
            return;
          }
          if (!payload.amount) {
            errorBox.textContent = 'Enter the amount that was spent.';
            errorBox.classList.remove('hidden');
            return;
          }

          errorBox.classList.add('hidden');
          saveButton.disabled = true;

          try {
            if (expense) {
              await api.patch(`/expenses/${expense.id}`, payload);
              toast('Expense updated.', 'success');
            } else {
              await api.post('/expenses', payload);
              toast(
                isAdmin ? 'Expense recorded.' : 'Expense submitted for approval.',
                'success'
              );
            }
            close();
            await refresh();
          } catch (error) {
            errorBox.textContent = error.message;
            errorBox.classList.remove('hidden');
            saveButton.disabled = false;
          }
        };

        form.addEventListener('submit', (event) => {
          event.preventDefault();
          save();
        });
        saveButton.addEventListener('click', save);
      }
    });
  }

  /* --------------------------------------------------------- categories */

  function categoryRows() {
    return categories
      .map(
        (category) => `
        <tr>
          <td>
            <strong>${esc(category.name)}</strong>
            ${category.isActive ? '' : '<span class="badge inactive">inactive</span>'}
            ${category.description ? `<div class="muted small">${esc(category.description)}</div>` : ''}
          </td>
          <td class="right nowrap">${
            category.budgetMinor === null
              ? '<span class="muted">No budget</span>'
              : esc(money(category.budgetMinor))
          }</td>
          <td class="right">${category.expenseCount}</td>
          <td class="right nowrap">
            <button class="btn ghost small" data-cat-edit="${category.id}">Edit</button>
            <button class="btn danger small" data-cat-delete="${category.id}">Delete</button>
          </td>
        </tr>`
      )
      .join('');
  }

  function openCategoriesModal() {
    openModal({
      title: 'Expense categories',
      body: `
        <div id="cat-error" class="alert error hidden"></div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th class="right">Monthly budget</th>
                <th class="right">Expenses</th>
                <th class="right">Actions</th>
              </tr>
            </thead>
            <tbody id="cat-rows">${categoryRows()}</tbody>
          </table>
        </div>

        <h3 style="margin:1.25rem 0 .75rem">Add a category</h3>
        <form id="cat-form" novalidate>
          <div class="grid-2">
            <div class="field">
              <label for="cat-name">Name</label>
              <input id="cat-name" name="name" required maxlength="80" placeholder="e.g. Sports" />
            </div>
            <div class="field">
              <label for="cat-budget">Monthly budget (${esc(currency)}, optional)</label>
              <input id="cat-budget" name="monthlyBudget" type="number" step="0.01" min="0" placeholder="0.00" />
            </div>
          </div>
          <div class="field">
            <label for="cat-description">Description (optional)</label>
            <input id="cat-description" name="description" maxlength="300" />
          </div>
          <button class="btn" type="submit">Add category</button>
        </form>`,
      onMount(modal, close) {
        const errorBox = $('#cat-error', modal);

        const reloadCategories = async () => {
          const fresh = await api.get('/expenses/categories');
          categories.length = 0;
          categories.push(...fresh.categories);
          $('#cat-rows', modal).innerHTML = categoryRows();
          bindRows();
        };

        const fail = (error) => {
          errorBox.textContent = error.message;
          errorBox.classList.remove('hidden');
        };

        function bindRows() {
          $$('[data-cat-delete]', modal).forEach((button) =>
            button.addEventListener('click', async () => {
              errorBox.classList.add('hidden');
              try {
                await api.delete(`/expenses/categories/${button.dataset.catDelete}`);
                toast('Category deleted.', 'success');
                await reloadCategories();
                await refresh();
              } catch (error) {
                fail(error);
              }
            })
          );

          $$('[data-cat-edit]', modal).forEach((button) =>
            button.addEventListener('click', () => {
              const category = categories.find(
                (candidate) => String(candidate.id) === button.dataset.catEdit
              );
              if (!category) return;
              close();
              openCategoryEditor(category);
            })
          );
        }

        bindRows();

        $('#cat-form', modal).addEventListener('submit', async (event) => {
          event.preventDefault();
          errorBox.classList.add('hidden');

          const name = $('#cat-name', modal).value.trim();
          if (!name) return fail(new Error('Give the category a name.'));

          try {
            await api.post('/expenses/categories', {
              name,
              monthlyBudget: $('#cat-budget', modal).value.trim(),
              description: $('#cat-description', modal).value.trim()
            });
            event.target.reset();
            toast('Category added.', 'success');
            await reloadCategories();
            await refresh();
          } catch (error) {
            fail(error);
          }
        });
      }
    });
  }

  function openCategoryEditor(category) {
    openModal({
      title: `Edit “${category.name}”`,
      body: `
        <div id="cat-edit-error" class="alert error hidden"></div>
        <form id="cat-edit-form" novalidate>
          <div class="field">
            <label for="ce-name">Name</label>
            <input id="ce-name" required maxlength="80" value="${esc(category.name)}" />
          </div>
          <div class="field">
            <label for="ce-budget">Monthly budget (${esc(currency)})</label>
            <input id="ce-budget" type="number" step="0.01" min="0"
                   value="${esc(category.budget ?? '')}" placeholder="Leave blank for no budget" />
          </div>
          <div class="field">
            <label for="ce-description">Description</label>
            <input id="ce-description" maxlength="300" value="${esc(category.description ?? '')}" />
          </div>
          <label class="checkline">
            <input id="ce-active" type="checkbox" ${category.isActive ? 'checked' : ''} />
            Active — can be chosen for new expenses
          </label>
        </form>`,
      footer: `
        <button class="btn ghost" data-close>Cancel</button>
        <button class="btn" data-save>Save changes</button>`,
      onMount(modal, close) {
        const errorBox = $('#cat-edit-error', modal);

        $('[data-save]', modal).addEventListener('click', async () => {
          errorBox.classList.add('hidden');
          try {
            await api.patch(`/expenses/categories/${category.id}`, {
              name: $('#ce-name', modal).value.trim(),
              monthlyBudget: $('#ce-budget', modal).value.trim(),
              description: $('#ce-description', modal).value.trim(),
              isActive: $('#ce-active', modal).checked
            });
            close();
            toast('Category updated.', 'success');

            const fresh = await api.get('/expenses/categories');
            categories.length = 0;
            categories.push(...fresh.categories);
            await refresh();
          } catch (error) {
            errorBox.textContent = error.message;
            errorBox.classList.remove('hidden');
          }
        });
      }
    });
  }

  /* ------------------------------------------------------------- events */

  async function setStatus(id, status) {
    try {
      await api.patch(`/expenses/${id}/status`, { status });
      toast(`Expense ${status}.`, 'success');
      await refresh();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  listBox.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;

    if (button.dataset.approve) return setStatus(button.dataset.approve, 'approved');
    if (button.dataset.reject) return setStatus(button.dataset.reject, 'rejected');

    if (button.dataset.page) {
      state.offset =
        button.dataset.page === 'next'
          ? state.offset + PAGE_SIZE
          : Math.max(0, state.offset - PAGE_SIZE);
      await loadList();
      return;
    }

    if (button.dataset.edit) {
      try {
        const { expense } = await api.get(`/expenses/${button.dataset.edit}`);
        openExpenseModal(expense);
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }

    if (button.dataset.delete) {
      const id = button.dataset.delete;
      confirmAction({
        title: 'Delete expense',
        message: 'This removes the entry from the ledger. It cannot be undone.',
        async onConfirm() {
          try {
            await api.delete(`/expenses/${id}`);
            toast('Expense deleted.', 'success');
            await refresh();
          } catch (error) {
            toast(error.message, 'error');
          }
        }
      });
    }
  });

  $('#exp-new', container).addEventListener('click', () => openExpenseModal());
  $('#exp-categories', container)?.addEventListener('click', openCategoriesModal);

  $('#exp-export', container).addEventListener('click', () => {
    window.location.href = `/api/expenses/export.csv${listQuery()}`;
  });

  $('#exp-month', container).addEventListener('change', (event) => {
    // An emptied month input reads as "", which would ask the API for
    // "?month=" and be rejected; fall back to the current month instead.
    state.month = event.target.value || currentMonth();
    event.target.value = state.month;
    loadSummary();
  });

  const applyFilters = () => {
    const from = $('#exp-from', container).value;
    const to = $('#exp-to', container).value;

    if (from && to && from > to) {
      toast('The "from" date must not be after the "to" date.', 'error');
      return;
    }

    state.q = $('#exp-search', container).value.trim();
    state.categoryId = $('#exp-category', container).value;
    state.status = $('#exp-status', container).value;
    state.from = from;
    state.to = to;
    state.offset = 0;
    loadList();
  };

  $('#exp-apply', container).addEventListener('click', applyFilters);

  $('#exp-search', container).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyFilters();
    }
  });

  $('#exp-clear', container).addEventListener('click', () => {
    $('#exp-search', container).value = '';
    $('#exp-category', container).value = '';
    $('#exp-status', container).value = '';
    $('#exp-from', container).value = '';
    $('#exp-to', container).value = '';
    applyFilters();
  });

  await refresh();
}

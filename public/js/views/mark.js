import { api } from '../api.js';
import { $, $$, emptyState, esc, formatDate, statusBadge, toast, today } from '../ui.js';

const STATUSES = ['present', 'absent', 'late', 'excused'];

/** One row of the marking sheet. */
function studentRow(student, index) {
  const chosen = student.status ?? 'present';

  const options = STATUSES.map((status) => {
    const id = `s${student.studentId}-${status}`;
    return `
      <input type="radio" name="status-${student.studentId}" id="${id}" value="${status}"
             ${chosen === status ? 'checked' : ''} />
      <label for="${id}" data-status="${status}">${status}</label>`;
  }).join('');

  return `
    <tr data-student="${student.studentId}">
      <td class="right muted">${index + 1}</td>
      <td class="nowrap"><strong>${esc(student.rollNumber ?? '—')}</strong></td>
      <td>${esc(student.name)}</td>
      <td><div class="status-group">${options}</div></td>
      <td><input type="text" data-note placeholder="Optional note" value="${esc(student.note ?? '')}" /></td>
    </tr>`;
}

export async function markView(container, { user }) {
  const { courses } = await api.get('/courses');
  const teachable = courses.filter((course) => course.isActive === 1);

  if (!teachable.length) {
    container.innerHTML = emptyState(
      user.role === 'admin'
        ? 'Create a course first, then you can mark attendance for it.'
        : 'You are not assigned to any active course yet. Ask an administrator to assign one.',
      '📚'
    );
    return;
  }

  const state = {
    courseId: String(teachable[0].id),
    date: today()
  };

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h2>Take attendance</h2>
      </div>
      <div class="card-body">
        <div class="toolbar">
          <div class="field">
            <label for="mark-course">Course</label>
            <select id="mark-course">
              ${teachable
                .map(
                  (course) =>
                    `<option value="${course.id}">${esc(course.code)} — ${esc(course.name)}</option>`
                )
                .join('')}
            </select>
          </div>
          <div class="field">
            <label for="mark-date">Date</label>
            <input id="mark-date" type="date" value="${state.date}" max="${today()}" />
          </div>
          <button class="btn ghost" id="mark-all-present">Mark all present</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div id="sheet-status"></div>
      <div id="sheet" class="card-body flush"><div class="loading">Loading…</div></div>
      <div class="sticky-actions">
        <button class="btn" id="save-sheet">Save attendance</button>
        <span class="muted small" id="save-hint"></span>
      </div>
    </div>`;

  const sheet = $('#sheet', container);
  const statusBar = $('#sheet-status', container);
  const saveButton = $('#save-sheet', container);
  const saveHint = $('#save-hint', container);

  async function loadSheet() {
    sheet.innerHTML = '<div class="loading">Loading…</div>';
    statusBar.innerHTML = '';
    saveHint.textContent = '';

    let data;
    try {
      data = await api.get(`/attendance/sheet${api.query(state)}`);
    } catch (error) {
      sheet.innerHTML = `<div class="card-body"><div class="alert error">${esc(error.message)}</div></div>`;
      saveButton.disabled = true;
      return;
    }

    if (!data.students.length) {
      sheet.innerHTML = emptyState('No students are enrolled in this course yet.', '👥');
      saveButton.disabled = true;
      return;
    }

    saveButton.disabled = false;

    if (data.alreadyMarked) {
      statusBar.innerHTML = `
        <div style="padding:1rem 1.25rem 0">
          <div class="alert info">Attendance for ${esc(
            formatDate(state.date)
          )} has already been saved. Saving again will update it.</div>
        </div>`;
    }

    sheet.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="right">#</th>
              <th>Roll no.</th>
              <th>Student</th>
              <th>Status</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>${data.students.map(studentRow).join('')}</tbody>
        </table>
      </div>`;
  }

  $('#mark-course', container).addEventListener('change', (event) => {
    state.courseId = event.target.value;
    loadSheet();
  });

  $('#mark-date', container).addEventListener('change', (event) => {
    state.date = event.target.value || today();
    loadSheet();
  });

  $('#mark-all-present', container).addEventListener('click', () => {
    $$('input[type="radio"][value="present"]', sheet).forEach((input) => {
      input.checked = true;
    });
    toast('Everyone marked present — remember to save.');
  });

  saveButton.addEventListener('click', async () => {
    const records = $$('tbody tr', sheet).map((row) => ({
      studentId: Number(row.dataset.student),
      status: $(`input[name="status-${row.dataset.student}"]:checked`, row)?.value ?? 'present',
      note: $('[data-note]', row).value.trim() || null
    }));

    if (!records.length) return;

    saveButton.disabled = true;
    saveHint.textContent = 'Saving…';

    try {
      const result = await api.post('/attendance/bulk', {
        courseId: Number(state.courseId),
        date: state.date,
        records
      });
      toast(`Saved attendance for ${result.saved} students.`, 'success');
      saveHint.textContent = `Last saved at ${new Date().toLocaleTimeString()}`;
      await loadSheet();
    } catch (error) {
      toast(error.message, 'error');
      saveHint.textContent = '';
    } finally {
      saveButton.disabled = false;
    }
  });

  await loadSheet();
}

/** Read-only history, shared by staff and students. */
export async function historyView(container, { user }) {
  const { courses } = await api.get('/courses');

  container.innerHTML = `
    <div class="card">
      <div class="card-header"><h2>Attendance records</h2></div>
      <div class="card-body">
        <div class="toolbar">
          <div class="field">
            <label for="hist-course">Course</label>
            <select id="hist-course">
              <option value="">All courses</option>
              ${courses
                .map((course) => `<option value="${course.id}">${esc(course.code)} — ${esc(course.name)}</option>`)
                .join('')}
            </select>
          </div>
          <div class="field">
            <label for="hist-from">From</label>
            <input id="hist-from" type="date" />
          </div>
          <div class="field">
            <label for="hist-to">To</label>
            <input id="hist-to" type="date" />
          </div>
          <div class="field">
            <label for="hist-status">Status</label>
            <select id="hist-status">
              <option value="">Any status</option>
              <option value="present">Present</option>
              <option value="absent">Absent</option>
              <option value="late">Late</option>
              <option value="excused">Excused</option>
            </select>
          </div>
          <button class="btn" id="hist-apply">Apply</button>
          ${user.role === 'student' ? '' : '<button class="btn ghost" id="hist-export">Export CSV</button>'}
        </div>
      </div>
      <div id="hist-results" class="card-body flush"><div class="loading">Loading…</div></div>
    </div>`;

  const results = $('#hist-results', container);

  const readFilters = () => ({
    courseId: $('#hist-course', container).value,
    from: $('#hist-from', container).value,
    to: $('#hist-to', container).value,
    status: $('#hist-status', container).value
  });

  async function load() {
    results.innerHTML = '<div class="loading">Loading…</div>';
    try {
      const { records } = await api.get(`/attendance${api.query(readFilters())}`);

      if (!records.length) {
        results.innerHTML = emptyState('No records match these filters.', '🔍');
        return;
      }

      results.innerHTML = `
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Course</th>
                ${user.role === 'student' ? '' : '<th>Student</th>'}
                <th>Status</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              ${records
                .map(
                  (record) => `
                <tr>
                  <td class="nowrap">${esc(formatDate(record.date))}</td>
                  <td><strong>${esc(record.courseCode)}</strong><div class="small muted">${esc(record.courseName)}</div></td>
                  ${
                    user.role === 'student'
                      ? ''
                      : `<td>${esc(record.studentName)}<div class="small muted">${esc(record.rollNumber ?? '')}</div></td>`
                  }
                  <td>${statusBadge(record.status)}</td>
                  <td class="muted small">${esc(record.note ?? '')}</td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
        <div class="card-body small muted">Showing ${records.length} record${records.length === 1 ? '' : 's'}${
          records.length === 1000 ? ' (limit reached — narrow the filters)' : ''
        }.</div>`;
    } catch (error) {
      results.innerHTML = `<div class="card-body"><div class="alert error">${esc(error.message)}</div></div>`;
    }
  }

  $('#hist-apply', container).addEventListener('click', load);
  $('#hist-export', container)?.addEventListener('click', () => {
    const { courseId, from, to } = readFilters();
    window.location.href = `/api/reports/export.csv${api.query({ courseId, from, to })}`;
  });

  await load();
}

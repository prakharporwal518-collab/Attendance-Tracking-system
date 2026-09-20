import { api } from '../api.js';
import { $, emptyState, esc, formatDate, rateBar, toast } from '../ui.js';

export async function reportsView(container, { params }) {
  const { courses } = await api.get('/courses');

  if (!courses.length) {
    container.innerHTML = emptyState('There are no courses to report on yet.', '📊');
    return;
  }

  const state = {
    courseId: params.get('courseId') ?? String(courses[0].id),
    from: '',
    to: ''
  };

  if (!courses.some((course) => String(course.id) === state.courseId)) {
    state.courseId = String(courses[0].id);
  }

  container.innerHTML = `
    <div class="card">
      <div class="card-header"><h2>Course report</h2></div>
      <div class="card-body">
        <div class="toolbar">
          <div class="field" style="flex:1">
            <label for="rep-course">Course</label>
            <select id="rep-course">
              ${courses
                .map(
                  (course) =>
                    `<option value="${course.id}" ${
                      String(course.id) === state.courseId ? 'selected' : ''
                    }>${esc(course.code)} — ${esc(course.name)}</option>`
                )
                .join('')}
            </select>
          </div>
          <div class="field">
            <label for="rep-from">From</label>
            <input id="rep-from" type="date" />
          </div>
          <div class="field">
            <label for="rep-to">To</label>
            <input id="rep-to" type="date" />
          </div>
          <button class="btn" id="rep-apply">Apply</button>
          <button class="btn ghost" id="rep-export">Export CSV</button>
        </div>
      </div>
    </div>

    <div id="rep-summary"></div>

    <div class="card">
      <div class="card-header">
        <h2>Per-student attendance</h2>
        <div class="spacer"></div>
        <span class="muted small">75% and above is green · 60–75% amber · below 60% red</span>
      </div>
      <div id="rep-results" class="card-body flush"><div class="loading">Loading…</div></div>
    </div>`;

  const results = $('#rep-results', container);
  const summary = $('#rep-summary', container);

  async function load() {
    results.innerHTML = '<div class="loading">Loading…</div>';
    summary.innerHTML = '';

    let data;
    try {
      data = await api.get(
        `/reports/course/${state.courseId}${api.query({ from: state.from, to: state.to })}`
      );
    } catch (error) {
      results.innerHTML = `<div class="card-body"><div class="alert error">${esc(error.message)}</div></div>`;
      return;
    }

    const { students, sessions, course } = data;
    const atRisk = students.filter((student) => student.rate !== null && student.rate < 75);
    const rated = students.filter((student) => student.rate !== null);
    const average = rated.length
      ? rated.reduce((total, student) => total + student.rate, 0) / rated.length
      : null;

    summary.innerHTML = `
      <div class="stat-grid">
        <div class="stat">
          <div class="label">Course</div>
          <div class="value" style="font-size:1.35rem">${esc(course.code)}</div>
          <div class="hint">${esc(course.name)}</div>
        </div>
        <div class="stat">
          <div class="label">Students</div>
          <div class="value">${students.length}</div>
        </div>
        <div class="stat">
          <div class="label">Sessions held</div>
          <div class="value">${sessions.length}</div>
          <div class="hint">${
            sessions.length ? `latest ${esc(formatDate(sessions[0]))}` : 'none recorded yet'
          }</div>
        </div>
        <div class="stat">
          <div class="label">Class average</div>
          <div class="value">${average === null ? '—' : `${average.toFixed(1)}%`}</div>
          <div class="hint">${atRisk.length} below 75%</div>
        </div>
      </div>`;

    if (!students.length) {
      results.innerHTML = emptyState('No students are enrolled in this course.', '👥');
      return;
    }

    results.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Roll no.</th>
              <th>Student</th>
              <th class="right">Sessions</th>
              <th class="right">Present</th>
              <th class="right">Late</th>
              <th class="right">Absent</th>
              <th class="right">Excused</th>
              <th>Attendance rate</th>
            </tr>
          </thead>
          <tbody>
            ${students
              .map(
                (student) => `
              <tr>
                <td class="nowrap"><strong>${esc(student.rollNumber ?? '—')}</strong></td>
                <td>${esc(student.name)}</td>
                <td class="right">${esc(student.totalSessions)}</td>
                <td class="right">${esc(student.present)}</td>
                <td class="right">${esc(student.late)}</td>
                <td class="right">${esc(student.absent)}</td>
                <td class="right">${esc(student.excused)}</td>
                <td>${rateBar(student.rate)}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>`;
  }

  $('#rep-course', container).addEventListener('change', (event) => {
    state.courseId = event.target.value;
    load();
  });

  $('#rep-apply', container).addEventListener('click', () => {
    state.from = $('#rep-from', container).value;
    state.to = $('#rep-to', container).value;

    if (state.from && state.to && state.from > state.to) {
      toast('The "from" date must not be after the "to" date.', 'error');
      return;
    }
    load();
  });

  $('#rep-export', container).addEventListener('click', () => {
    window.location.href = `/api/reports/export.csv${api.query({
      courseId: state.courseId,
      from: state.from,
      to: state.to
    })}`;
  });

  await load();
}

/** Change-password screen, available to every role. */
export async function settingsView(container, { user }) {
  container.innerHTML = `
    <div class="card" style="max-width:520px">
      <div class="card-header"><h2>My account</h2></div>
      <div class="card-body">
        <p class="muted small">
          ${esc(user.name)} · ${esc(user.email)} · ${esc(user.role)}
          ${user.rollNumber ? ` · roll number ${esc(user.rollNumber)}` : ''}
        </p>

        <h3 style="margin:1.25rem 0 .75rem">Change password</h3>
        <div id="pw-error" class="alert error hidden"></div>
        <form id="pw-form" novalidate>
          <div class="field">
            <label for="pw-current">Current password</label>
            <input id="pw-current" name="currentPassword" type="password" autocomplete="current-password" required />
          </div>
          <div class="field">
            <label for="pw-new">New password</label>
            <input id="pw-new" name="newPassword" type="password" autocomplete="new-password"
                   placeholder="At least 8 characters" required />
          </div>
          <div class="field">
            <label for="pw-confirm">Confirm new password</label>
            <input id="pw-confirm" name="confirm" type="password" autocomplete="new-password" required />
          </div>
          <button class="btn" type="submit">Update password</button>
        </form>
      </div>
    </div>`;

  const errorBox = $('#pw-error', container);

  $('#pw-form', container).addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.classList.add('hidden');

    const currentPassword = $('#pw-current', container).value;
    const newPassword = $('#pw-new', container).value;
    const confirm = $('#pw-confirm', container).value;

    if (newPassword !== confirm) {
      errorBox.textContent = 'The two new passwords do not match.';
      errorBox.classList.remove('hidden');
      return;
    }

    try {
      await api.post('/auth/change-password', { currentPassword, newPassword });
      toast('Password updated.', 'success');
      event.target.reset();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.classList.remove('hidden');
    }
  });
}

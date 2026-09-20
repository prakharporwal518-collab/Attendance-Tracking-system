import { api } from '../api.js';
import { emptyState, esc, formatDate, formatShortDate, rateBar, statusBadge } from '../ui.js';

const statCard = (label, value, hint = '') => `
  <div class="stat">
    <div class="label">${esc(label)}</div>
    <div class="value">${esc(value)}</div>
    ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
  </div>`;

/** A simple bar chart of daily attendance rates, drawn with plain divs. */
function trendChart(points) {
  if (!points.length) return emptyState('No attendance has been recorded yet.', '📈');

  const columns = points
    .map((point) => {
      const rate = point.rate ?? 0;
      return `
        <div class="col" title="${esc(formatDate(point.date))} — ${rate.toFixed(1)}%">
          <div class="fill" style="height:${Math.max(2, rate)}%"></div>
          <div class="tick">${esc(formatShortDate(point.date))}</div>
        </div>`;
    })
    .join('');

  return `<div class="chart">${columns}</div>`;
}

function courseTable(rows, { showStudents = false } = {}) {
  if (!rows.length) return emptyState('No courses to show yet.', '📚');

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Course</th>
            ${showStudents ? '<th class="right">Students</th>' : ''}
            <th class="right">Sessions</th>
            <th class="right">Present</th>
            <th class="right">Absent</th>
            <th>Attendance rate</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (row) => `
            <tr>
              <td><strong>${esc(row.code)}</strong><div class="small muted">${esc(row.name)}</div></td>
              ${showStudents ? `<td class="right">${esc(row.studentCount ?? 0)}</td>` : ''}
              <td class="right">${esc(row.totalSessions ?? 0)}</td>
              <td class="right">${esc(row.present ?? 0)}</td>
              <td class="right">${esc(row.absent ?? 0)}</td>
              <td>${rateBar(row.rate)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

export async function dashboardView(container, { user }) {
  const data = await api.get('/reports/dashboard');
  const { overall, counts, byCourse = [] } = data;

  if (user.role === 'student') {
    const warning =
      overall.rate !== null && overall.rate < 75
        ? `<div class="alert error">Your overall attendance is ${overall.rate.toFixed(
            1
          )}%, which is below the usual 75% requirement.</div>`
        : '';

    container.innerHTML = `
      ${warning}
      <div class="stat-grid">
        ${statCard('Overall attendance', overall.rate === null ? '—' : `${overall.rate.toFixed(1)}%`)}
        ${statCard('Courses enrolled', counts.courses)}
        ${statCard('Classes attended', (overall.present ?? 0) + (overall.late ?? 0), `out of ${overall.totalSessions ?? 0} recorded`)}
        ${statCard('Times absent', overall.absent ?? 0)}
      </div>

      <div class="card">
        <div class="card-header"><h2>Attendance by course</h2></div>
        <div class="card-body flush">${courseTable(byCourse)}</div>
      </div>

      <div class="card">
        <div class="card-header"><h2>Recent classes</h2></div>
        <div class="card-body flush">
          ${
            data.recent?.length
              ? `<div class="table-wrap"><table>
                  <thead><tr><th>Date</th><th>Course</th><th>Status</th></tr></thead>
                  <tbody>
                    ${data.recent
                      .map(
                        (row) => `
                      <tr>
                        <td class="nowrap">${esc(formatDate(row.date))}</td>
                        <td><strong>${esc(row.courseCode)}</strong> <span class="muted small">${esc(row.courseName)}</span></td>
                        <td>${statusBadge(row.status)}</td>
                      </tr>`
                      )
                      .join('')}
                  </tbody>
                </table></div>`
              : emptyState('Nothing has been marked for you yet.', '🗓️')
          }
        </div>
      </div>`;
    return;
  }

  if (user.role === 'teacher') {
    container.innerHTML = `
      <div class="stat-grid">
        ${statCard('My courses', counts.courses)}
        ${statCard('Students taught', counts.students)}
        ${statCard('Records marked', counts.records)}
        ${statCard('Average attendance', overall.rate === null ? '—' : `${overall.rate.toFixed(1)}%`)}
      </div>

      <div class="card">
        <div class="card-header">
          <h2>My courses</h2>
          <div class="spacer"></div>
          <a class="btn small" href="#/mark">Take attendance</a>
        </div>
        <div class="card-body flush">${courseTable(byCourse, { showStudents: true })}</div>
      </div>`;
    return;
  }

  container.innerHTML = `
    <div class="stat-grid">
      ${statCard('Active students', counts.students)}
      ${statCard('Teachers', counts.teachers)}
      ${statCard('Active courses', counts.courses)}
      ${statCard('Overall attendance', overall.rate === null ? '—' : `${overall.rate.toFixed(1)}%`, `${counts.records} records`)}
    </div>

    <div class="card">
      <div class="card-header"><h2>Daily attendance rate</h2><span class="muted small">last 14 recorded days</span></div>
      <div class="card-body">${trendChart(data.recent ?? [])}</div>
    </div>

    <div class="card">
      <div class="card-header"><h2>Courses</h2></div>
      <div class="card-body flush">${courseTable(byCourse)}</div>
    </div>`;
}

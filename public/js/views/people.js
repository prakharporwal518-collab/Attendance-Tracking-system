import { api } from '../api.js';
import {
  $, $$, confirmAction, emptyState, esc, formData, openModal, rateBar, roleBadge, toast
} from '../ui.js';

function userForm({ person = null, onSaved }) {
  const isEdit = Boolean(person);

  openModal({
    title: isEdit ? `Edit ${person.name}` : 'Add person',
    body: `
      <div id="user-error" class="alert error hidden"></div>
      <form id="user-form" novalidate>
        <div class="field">
          <label for="u-name">Full name</label>
          <input id="u-name" name="name" required value="${esc(person?.name ?? '')}" />
        </div>
        <div class="field">
          <label for="u-email">Email address</label>
          <input id="u-email" name="email" type="email" required value="${esc(person?.email ?? '')}" />
        </div>
        <div class="field">
          <label for="u-role">Role</label>
          <select id="u-role" name="role">
            ${['student', 'teacher', 'admin']
              .map(
                (role) =>
                  `<option value="${role}" ${
                    (person?.role ?? 'student') === role ? 'selected' : ''
                  }>${role[0].toUpperCase()}${role.slice(1)}</option>`
              )
              .join('')}
          </select>
        </div>
        <div class="field" id="roll-field">
          <label for="u-roll">Roll number</label>
          <input id="u-roll" name="rollNumber" maxlength="50" value="${esc(person?.rollNumber ?? '')}" />
        </div>
        <div class="field">
          <label for="u-department">Department</label>
          <input id="u-department" name="department" value="${esc(person?.department ?? '')}" />
        </div>
        <div class="field">
          <label for="u-password">${isEdit ? 'New password (leave blank to keep current)' : 'Password'}</label>
          <input id="u-password" name="password" type="password" autocomplete="new-password"
                 placeholder="At least 8 characters" ${isEdit ? '' : 'required'} />
        </div>
      </form>`,
    footer: `
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn" id="user-save">${isEdit ? 'Save changes' : 'Create account'}</button>`,
    onMount(modal, close) {
      const errorBox = $('#user-error', modal);
      const form = $('#user-form', modal);
      const roleSelect = $('#u-role', modal);
      const rollField = $('#roll-field', modal);

      const syncRollField = () => {
        rollField.classList.toggle('hidden', roleSelect.value !== 'student');
      };
      roleSelect.addEventListener('change', syncRollField);
      syncRollField();

      const submit = async () => {
        const values = formData(form);
        const payload = {
          name: values.name,
          email: values.email,
          role: values.role,
          department: values.department || null,
          rollNumber: values.role === 'student' ? values.rollNumber || null : null
        };
        if (values.password) payload.password = values.password;

        try {
          if (isEdit) await api.patch(`/users/${person.id}`, payload);
          else await api.post('/users', payload);

          close();
          toast(isEdit ? 'Account updated.' : 'Account created.', 'success');
          await onSaved();
        } catch (error) {
          errorBox.textContent = error.message;
          errorBox.classList.remove('hidden');
        }
      };

      $('#user-save', modal).addEventListener('click', submit);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        submit();
      });
    }
  });
}

/** A read-only breakdown of one student's attendance. */
async function showStudentReport(studentId) {
  const data = await api.get(`/reports/student/${studentId}`);

  openModal({
    title: `${data.student.name} — attendance`,
    body: `
      <p class="muted small">
        ${esc(data.student.rollNumber ?? '')} · ${esc(data.student.email)}
      </p>
      <div class="stat-grid" style="grid-template-columns:repeat(2,1fr);margin-bottom:1rem">
        <div class="stat">
          <div class="label">Overall</div>
          <div class="value">${data.overall.rate === null ? '—' : `${data.overall.rate.toFixed(1)}%`}</div>
        </div>
        <div class="stat">
          <div class="label">Absences</div>
          <div class="value">${esc(data.overall.absent ?? 0)}</div>
        </div>
      </div>
      ${
        data.byCourse.length
          ? `<div class="table-wrap"><table>
              <thead><tr><th>Course</th><th class="right">Sessions</th><th>Rate</th></tr></thead>
              <tbody>
                ${data.byCourse
                  .map(
                    (row) => `
                  <tr>
                    <td><strong>${esc(row.code)}</strong><div class="small muted">${esc(row.name)}</div></td>
                    <td class="right">${esc(row.totalSessions)}</td>
                    <td>${rateBar(row.rate)}</td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table></div>`
          : emptyState('Not enrolled in any course yet.', '📚')
      }`,
    footer: '<button class="btn ghost" data-close>Close</button>'
  });
}

export async function peopleView(container, { user }) {
  const isAdmin = user.role === 'admin';
  const state = { role: '', search: '' };

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h2>People</h2>
        <div class="spacer"></div>
        ${isAdmin ? '<button class="btn" id="new-user">+ Add person</button>' : ''}
      </div>
      <div class="card-body">
        <div class="toolbar">
          <div class="field">
            <label for="people-role">Role</label>
            <select id="people-role">
              <option value="">All roles</option>
              <option value="student">Students</option>
              <option value="teacher">Teachers</option>
              <option value="admin">Administrators</option>
            </select>
          </div>
          <div class="field" style="flex:1">
            <label for="people-search">Search</label>
            <input id="people-search" type="search" placeholder="Name, email or roll number" />
          </div>
        </div>
      </div>
      <div id="people-results" class="card-body flush"><div class="loading">Loading…</div></div>
    </div>`;

  const results = $('#people-results', container);

  async function render() {
    results.innerHTML = '<div class="loading">Loading…</div>';

    let users;
    try {
      ({ users } = await api.get(`/users${api.query(state)}`));
    } catch (error) {
      results.innerHTML = `<div class="card-body"><div class="alert error">${esc(error.message)}</div></div>`;
      return;
    }

    if (!users.length) {
      results.innerHTML = emptyState('Nobody matches this search.', '🔍');
      return;
    }

    results.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Roll no.</th>
              <th>Status</th>
              <th class="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${users
              .map(
                (person) => `
              <tr>
                <td><strong>${esc(person.name)}</strong><div class="small muted">${esc(person.department ?? '')}</div></td>
                <td class="small">${esc(person.email)}</td>
                <td>${roleBadge(person.role)}</td>
                <td>${esc(person.rollNumber ?? '—')}</td>
                <td>${
                  person.isActive
                    ? '<span class="badge present">active</span>'
                    : '<span class="badge inactive">inactive</span>'
                }</td>
                <td class="right nowrap">
                  ${person.role === 'student' ? `<button class="btn ghost small" data-view="${person.id}">View</button>` : ''}
                  ${
                    isAdmin
                      ? `<button class="btn ghost small" data-edit="${person.id}">Edit</button>
                         ${
                           person.id === user.id
                             ? ''
                             : `<button class="btn ghost small" data-toggle="${person.id}">${
                                 person.isActive ? 'Deactivate' : 'Activate'
                               }</button>
                                <button class="btn danger small" data-delete="${person.id}">Delete</button>`
                         }`
                      : ''
                  }
                </td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
      <div class="card-body small muted">${users.length} ${users.length === 1 ? 'person' : 'people'}.</div>`;

    const byId = (id) => users.find((person) => person.id === Number(id));

    $$('[data-view]', results).forEach((button) =>
      button.addEventListener('click', () => showStudentReport(button.dataset.view))
    );

    $$('[data-edit]', results).forEach((button) =>
      button.addEventListener('click', () => userForm({ person: byId(button.dataset.edit), onSaved: render }))
    );

    $$('[data-toggle]', results).forEach((button) =>
      button.addEventListener('click', async () => {
        const person = byId(button.dataset.toggle);
        try {
          await api.patch(`/users/${person.id}`, { isActive: person.isActive !== 1 });
          toast(person.isActive ? 'Account deactivated.' : 'Account activated.', 'success');
          await render();
        } catch (error) {
          toast(error.message, 'error');
        }
      })
    );

    $$('[data-delete]', results).forEach((button) =>
      button.addEventListener('click', () => {
        const person = byId(button.dataset.delete);
        confirmAction({
          title: `Delete ${person.name}?`,
          message:
            'This permanently removes the account along with their enrollments and attendance records. Deactivating instead keeps the history.',
          onConfirm: async () => {
            try {
              await api.delete(`/users/${person.id}`);
              toast('Account deleted.', 'success');
              await render();
            } catch (error) {
              toast(error.message, 'error');
            }
          }
        });
      })
    );
  }

  $('#new-user', container)?.addEventListener('click', () => userForm({ onSaved: render }));

  $('#people-role', container).addEventListener('change', (event) => {
    state.role = event.target.value;
    render();
  });

  let debounce;
  $('#people-search', container).addEventListener('input', (event) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.search = event.target.value.trim();
      render();
    }, 250);
  });

  await render();
}

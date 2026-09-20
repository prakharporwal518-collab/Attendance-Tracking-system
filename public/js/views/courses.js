import { api } from '../api.js';
import { $, $$, confirmAction, emptyState, esc, formData, openModal, toast } from '../ui.js';

/** Admin-only create/edit dialog. */
function courseForm({ course = null, teachers, onSaved }) {
  const isEdit = Boolean(course);

  openModal({
    title: isEdit ? `Edit ${course.code}` : 'New course',
    body: `
      <div id="course-error" class="alert error hidden"></div>
      <form id="course-form" novalidate>
        <div class="field">
          <label for="course-code">Course code</label>
          <input id="course-code" name="code" required maxlength="30"
                 value="${esc(course?.code ?? '')}" placeholder="CS201" />
        </div>
        <div class="field">
          <label for="course-name">Course name</label>
          <input id="course-name" name="name" required
                 value="${esc(course?.name ?? '')}" placeholder="Data Structures and Algorithms" />
        </div>
        <div class="field">
          <label for="course-department">Department</label>
          <input id="course-department" name="department" value="${esc(course?.department ?? '')}" />
        </div>
        <div class="field">
          <label for="course-teacher">Teacher</label>
          <select id="course-teacher" name="teacherId">
            <option value="">Not assigned</option>
            ${teachers
              .map(
                (teacher) =>
                  `<option value="${teacher.id}" ${
                    course?.teacherId === teacher.id ? 'selected' : ''
                  }>${esc(teacher.name)}</option>`
              )
              .join('')}
          </select>
        </div>
      </form>`,
    footer: `
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn" id="course-save">${isEdit ? 'Save changes' : 'Create course'}</button>`,
    onMount(modal, close) {
      const errorBox = $('#course-error', modal);
      const form = $('#course-form', modal);

      const submit = async () => {
        const values = formData(form);
        const payload = {
          code: values.code,
          name: values.name,
          department: values.department || null,
          teacherId: values.teacherId ? Number(values.teacherId) : null
        };

        try {
          if (isEdit) await api.patch(`/courses/${course.id}`, payload);
          else await api.post('/courses', payload);

          close();
          toast(isEdit ? 'Course updated.' : 'Course created.', 'success');
          await onSaved();
        } catch (error) {
          errorBox.textContent = error.message;
          errorBox.classList.remove('hidden');
        }
      };

      $('#course-save', modal).addEventListener('click', submit);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        submit();
      });
    }
  });
}

/** Enrollment picker: tick the students who belong to this course. */
async function manageRoster(course, onSaved) {
  const [{ users: students }, { students: enrolled }] = await Promise.all([
    api.get('/users?role=student&activeOnly=true'),
    api.get(`/courses/${course.id}/students`)
  ]);

  const enrolledIds = new Set(enrolled.map((student) => student.id));

  openModal({
    title: `Students in ${course.code}`,
    body: `
      <div id="roster-error" class="alert error hidden"></div>
      <div class="field">
        <label for="roster-search">Search</label>
        <input id="roster-search" type="search" placeholder="Name or roll number" />
      </div>
      <div class="checklist" id="roster-list">
        ${students
          .map(
            (student) => `
          <label data-search="${esc(`${student.name} ${student.rollNumber ?? ''}`.toLowerCase())}">
            <input type="checkbox" value="${student.id}" ${enrolledIds.has(student.id) ? 'checked' : ''} />
            <span><strong>${esc(student.rollNumber ?? '—')}</strong> · ${esc(student.name)}</span>
          </label>`
          )
          .join('')}
      </div>
      <p class="small muted" style="margin-top:.75rem">
        Unticking a student removes them from the course. Their past attendance records are removed too.
      </p>`,
    footer: `
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn" id="roster-save">Save roster</button>`,
    onMount(modal, close) {
      const errorBox = $('#roster-error', modal);

      $('#roster-search', modal).addEventListener('input', (event) => {
        const term = event.target.value.trim().toLowerCase();
        $$('#roster-list label', modal).forEach((label) => {
          label.classList.toggle('hidden', term !== '' && !label.dataset.search.includes(term));
        });
      });

      $('#roster-save', modal).addEventListener('click', async () => {
        const studentIds = $$('#roster-list input:checked', modal).map((input) => Number(input.value));
        try {
          await api.post(`/courses/${course.id}/students`, { studentIds, replace: true });
          close();
          toast('Roster updated.', 'success');
          await onSaved();
        } catch (error) {
          errorBox.textContent = error.message;
          errorBox.classList.remove('hidden');
        }
      });
    }
  });
}

export async function coursesView(container, { user, navigate }) {
  const isAdmin = user.role === 'admin';

  async function render() {
    const { courses } = await api.get('/courses');
    const teachers = isAdmin ? (await api.get('/users?role=teacher&activeOnly=true')).users : [];

    container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h2>Courses</h2>
          <div class="spacer"></div>
          ${isAdmin ? '<button class="btn" id="new-course">+ New course</button>' : ''}
        </div>
        <div class="card-body flush">
          ${
            courses.length
              ? `<div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Code</th>
                        <th>Name</th>
                        <th>Teacher</th>
                        <th class="right">Students</th>
                        <th>Status</th>
                        <th class="right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${courses
                        .map(
                          (course) => `
                        <tr>
                          <td><strong>${esc(course.code)}</strong></td>
                          <td>${esc(course.name)}<div class="small muted">${esc(course.department ?? '')}</div></td>
                          <td>${esc(course.teacherName ?? '—')}</td>
                          <td class="right">${course.studentCount}</td>
                          <td>${
                            course.isActive
                              ? '<span class="badge present">active</span>'
                              : '<span class="badge inactive">archived</span>'
                          }</td>
                          <td class="right nowrap">
                            ${
                              user.role === 'student'
                                ? ''
                                : `<button class="btn ghost small" data-roster="${course.id}">Roster</button>
                                   <button class="btn ghost small" data-report="${course.id}">Report</button>`
                            }
                            ${
                              isAdmin
                                ? `<button class="btn ghost small" data-edit="${course.id}">Edit</button>
                                   <button class="btn danger small" data-delete="${course.id}">Delete</button>`
                                : ''
                            }
                          </td>
                        </tr>`
                        )
                        .join('')}
                    </tbody>
                  </table>
                </div>`
              : emptyState(
                  isAdmin ? 'No courses yet. Create the first one.' : 'You have no courses yet.',
                  '📚'
                )
          }
        </div>
      </div>`;

    const byId = (id) => courses.find((course) => course.id === Number(id));

    $('#new-course', container)?.addEventListener('click', () =>
      courseForm({ teachers, onSaved: render })
    );

    $$('[data-edit]', container).forEach((button) =>
      button.addEventListener('click', () =>
        courseForm({ course: byId(button.dataset.edit), teachers, onSaved: render })
      )
    );

    $$('[data-roster]', container).forEach((button) =>
      button.addEventListener('click', () => manageRoster(byId(button.dataset.roster), render))
    );

    $$('[data-report]', container).forEach((button) =>
      button.addEventListener('click', () => navigate(`#/reports?courseId=${button.dataset.report}`))
    );

    $$('[data-delete]', container).forEach((button) =>
      button.addEventListener('click', () => {
        const course = byId(button.dataset.delete);
        confirmAction({
          title: `Delete ${course.code}?`,
          message: `This removes the course along with its roster and every attendance record for it. This cannot be undone.`,
          onConfirm: async () => {
            try {
              await api.delete(`/courses/${course.id}`);
              toast('Course deleted.', 'success');
              await render();
            } catch (error) {
              toast(error.message, 'error');
            }
          }
        });
      })
    );
  }

  await render();
}

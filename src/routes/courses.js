import { Router } from 'express';
import { all, get, run, transaction } from '../db/index.js';
import { authenticate, canManageCourse, requireRoles } from '../middleware/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { optionalId, optionalString, requireId, requireString } from '../utils/validate.js';

export const coursesRouter = Router();

coursesRouter.use(authenticate);

const SELECT_COURSE = `
  SELECT c.id,
         c.code,
         c.name,
         c.department,
         c.teacher_id           AS teacherId,
         t.name                 AS teacherName,
         c.is_active            AS isActive,
         c.created_at           AS createdAt,
         (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id) AS studentCount
    FROM courses c
    LEFT JOIN users t ON t.id = c.teacher_id`;

/** Load a course or throw a 404. */
function loadCourse(id) {
  const course = get(`${SELECT_COURSE} WHERE c.id = :id`, { id });
  if (!course) throw notFound('Course not found.');
  return course;
}

/**
 * Courses the caller is allowed to see: admins see everything, teachers see
 * what they teach, students see what they are enrolled in.
 */
coursesRouter.get('/', (req, res) => {
  const { role, id } = req.user;

  if (role === 'admin') {
    return res.json({ courses: all(`${SELECT_COURSE} ORDER BY c.code`) });
  }
  if (role === 'teacher') {
    return res.json({
      courses: all(`${SELECT_COURSE} WHERE c.teacher_id = :id ORDER BY c.code`, { id })
    });
  }
  res.json({
    courses: all(
      `${SELECT_COURSE}
         WHERE c.id IN (SELECT course_id FROM enrollments WHERE student_id = :id)
         ORDER BY c.code`,
      { id }
    )
  });
});

coursesRouter.get('/:id', (req, res) => {
  const course = loadCourse(requireId(req.params.id));

  if (req.user.role === 'student') {
    const enrolled = get(
      'SELECT id FROM enrollments WHERE course_id = :courseId AND student_id = :studentId',
      { courseId: course.id, studentId: req.user.id }
    );
    if (!enrolled) throw forbidden('You are not enrolled in this course.');
  } else if (!canManageCourse(req.user, course)) {
    throw forbidden('You do not teach this course.');
  }

  res.json({ course });
});

coursesRouter.post('/', requireRoles('admin'), (req, res) => {
  const code = requireString(req.body?.code, 'code', { max: 30 }).toUpperCase();
  const name = requireString(req.body?.name, 'name');
  const department = optionalString(req.body?.department, 'department');
  const teacherId = optionalId(req.body?.teacherId, 'teacherId');

  if (get('SELECT id FROM courses WHERE code = :code', { code })) {
    throw conflict('A course with that code already exists.');
  }
  if (teacherId) {
    const teacher = get("SELECT id FROM users WHERE id = :teacherId AND role = 'teacher'", { teacherId });
    if (!teacher) throw badRequest('That teacher does not exist.');
  }

  const { lastInsertRowid } = run(
    `INSERT INTO courses (code, name, department, teacher_id)
     VALUES (:code, :name, :department, :teacherId)`,
    { code, name, department, teacherId }
  );

  res.status(201).json({ course: loadCourse(Number(lastInsertRowid)) });
});

coursesRouter.patch('/:id', requireRoles('admin'), (req, res) => {
  const id = requireId(req.params.id);
  loadCourse(id);

  const updates = {};

  if (req.body?.code !== undefined) {
    const code = requireString(req.body.code, 'code', { max: 30 }).toUpperCase();
    if (get('SELECT id FROM courses WHERE code = :code AND id != :id', { code, id })) {
      throw conflict('Another course already uses that code.');
    }
    updates.code = code;
  }
  if (req.body?.name !== undefined) updates.name = requireString(req.body.name, 'name');
  if (req.body?.department !== undefined) {
    updates.department = optionalString(req.body.department, 'department');
  }
  if (req.body?.teacherId !== undefined) {
    const teacherId = optionalId(req.body.teacherId, 'teacherId');
    if (teacherId) {
      const teacher = get("SELECT id FROM users WHERE id = :teacherId AND role = 'teacher'", { teacherId });
      if (!teacher) throw badRequest('That teacher does not exist.');
    }
    updates.teacher_id = teacherId;
  }
  if (req.body?.isActive !== undefined) {
    if (typeof req.body.isActive !== 'boolean') {
      throw badRequest('"isActive" must be true or false.');
    }
    updates.is_active = req.body.isActive ? 1 : 0;
  }

  if (Object.keys(updates).length === 0) throw badRequest('No changes were provided.');

  const assignments = Object.keys(updates).map((column) => `${column} = :${column}`).join(', ');
  run(`UPDATE courses SET ${assignments} WHERE id = :id`, { ...updates, id });

  res.json({ course: loadCourse(id) });
});

coursesRouter.delete('/:id', requireRoles('admin'), (req, res) => {
  const id = requireId(req.params.id);
  loadCourse(id);
  run('DELETE FROM courses WHERE id = :id', { id });
  res.json({ ok: true });
});

/* ------------------------------ enrollments ------------------------------ */

/** Students enrolled in a course, with their attendance summary attached. */
coursesRouter.get('/:id/students', (req, res) => {
  const course = loadCourse(requireId(req.params.id));
  if (!canManageCourse(req.user, course)) {
    throw forbidden('You do not teach this course.');
  }

  const students = all(
    `SELECT u.id,
            u.name,
            u.email,
            u.roll_number AS rollNumber,
            u.department,
            COUNT(a.id)                                          AS totalSessions,
            SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present,
            SUM(CASE WHEN a.status = 'absent'  THEN 1 ELSE 0 END) AS absent,
            SUM(CASE WHEN a.status = 'late'    THEN 1 ELSE 0 END) AS late,
            SUM(CASE WHEN a.status = 'excused' THEN 1 ELSE 0 END) AS excused
       FROM enrollments e
       JOIN users u ON u.id = e.student_id
       LEFT JOIN attendance a
              ON a.student_id = u.id AND a.course_id = e.course_id
      WHERE e.course_id = :courseId
      GROUP BY u.id
      ORDER BY IFNULL(u.roll_number, u.name)`,
    { courseId: course.id }
  );

  res.json({ students });
});

/** Replace or extend a course roster. */
coursesRouter.post('/:id/students', requireRoles('admin', 'teacher'), (req, res) => {
  const course = loadCourse(requireId(req.params.id));
  if (!canManageCourse(req.user, course)) {
    throw forbidden('You do not teach this course.');
  }

  const ids = req.body?.studentIds;
  if (!Array.isArray(ids)) throw badRequest('"studentIds" must be an array.');

  const studentIds = [...new Set(ids.map((value) => requireId(value, 'studentIds[]')))];

  for (const studentId of studentIds) {
    const student = get("SELECT id FROM users WHERE id = :studentId AND role = 'student'", { studentId });
    if (!student) throw badRequest(`User ${studentId} is not a student.`);
  }

  const replace = req.body?.replace === true;

  transaction(() => {
    if (replace) {
      const keep = studentIds.length ? studentIds.join(',') : '-1';
      run(
        `DELETE FROM enrollments
          WHERE course_id = :courseId AND student_id NOT IN (${keep})`,
        { courseId: course.id }
      );
    }
    for (const studentId of studentIds) {
      run(
        `INSERT OR IGNORE INTO enrollments (course_id, student_id)
         VALUES (:courseId, :studentId)`,
        { courseId: course.id, studentId }
      );
    }
  });

  res.json({ ok: true, enrolled: studentIds.length });
});

coursesRouter.delete('/:id/students/:studentId', requireRoles('admin', 'teacher'), (req, res) => {
  const course = loadCourse(requireId(req.params.id));
  if (!canManageCourse(req.user, course)) {
    throw forbidden('You do not teach this course.');
  }

  const studentId = requireId(req.params.studentId, 'studentId');
  const { changes } = run(
    'DELETE FROM enrollments WHERE course_id = :courseId AND student_id = :studentId',
    { courseId: course.id, studentId }
  );

  if (changes === 0) throw notFound('That student is not enrolled in this course.');
  res.json({ ok: true });
});

export { loadCourse };

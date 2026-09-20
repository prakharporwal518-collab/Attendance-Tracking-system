import { Router } from 'express';
import { all, get, run, transaction } from '../db/index.js';
import { authenticate, canManageCourse, requireRoles } from '../middleware/auth.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';
import { loadCourse } from './courses.js';
import {
  optionalDate,
  optionalString,
  requireDate,
  requireId,
  requireStatus,
  today
} from '../utils/validate.js';

export const attendanceRouter = Router();

attendanceRouter.use(authenticate);

/** Throw unless the caller may mark attendance for this course. */
function assertCanMark(user, course) {
  if (!canManageCourse(user, course)) {
    throw forbidden('Only the course teacher or an administrator can mark attendance.');
  }
  if (course.isActive !== 1) {
    throw badRequest('This course is archived, so its attendance cannot be changed.');
  }
}

/**
 * The roster for one course on one date, with whatever has already been
 * marked. This is what the "take attendance" screen loads.
 */
attendanceRouter.get('/sheet', requireRoles('admin', 'teacher'), (req, res) => {
  const courseId = requireId(req.query.courseId, 'courseId');
  const date = req.query.date ? requireDate(req.query.date) : today();

  const course = loadCourse(courseId);
  if (!canManageCourse(req.user, course)) {
    throw forbidden('You do not teach this course.');
  }

  const rows = all(
    `SELECT u.id            AS studentId,
            u.name,
            u.roll_number   AS rollNumber,
            a.status,
            a.note,
            a.marked_at     AS markedAt
       FROM enrollments e
       JOIN users u ON u.id = e.student_id
       LEFT JOIN attendance a
              ON a.student_id = u.id
             AND a.course_id  = e.course_id
             AND a.session_date = :date
      WHERE e.course_id = :courseId
      ORDER BY IFNULL(u.roll_number, u.name)`,
    { courseId, date }
  );

  const alreadyMarked = rows.some((row) => row.status !== null);
  res.json({ course, date, alreadyMarked, students: rows });
});

/**
 * Save a whole sheet at once. Re-saving the same date overwrites the previous
 * marks, which is what a teacher expects when they fix a mistake.
 */
attendanceRouter.post('/bulk', requireRoles('admin', 'teacher'), (req, res) => {
  const courseId = requireId(req.body?.courseId, 'courseId');
  const date = requireDate(req.body?.date);
  const course = loadCourse(courseId);
  assertCanMark(req.user, course);

  if (date > today()) {
    throw badRequest('Attendance cannot be marked for a future date.');
  }

  const records = req.body?.records;
  if (!Array.isArray(records) || records.length === 0) {
    throw badRequest('"records" must be a non-empty array.');
  }

  const prepared = records.map((record) => ({
    studentId: requireId(record?.studentId, 'studentId'),
    status: requireStatus(record?.status),
    note: optionalString(record?.note, 'note', { max: 500 })
  }));

  const enrolled = new Set(
    all('SELECT student_id AS studentId FROM enrollments WHERE course_id = :courseId', { courseId })
      .map((row) => row.studentId)
  );

  for (const record of prepared) {
    if (!enrolled.has(record.studentId)) {
      throw badRequest(`Student ${record.studentId} is not enrolled in this course.`);
    }
  }

  transaction(() => {
    for (const record of prepared) {
      run(
        `INSERT INTO attendance (course_id, student_id, session_date, status, note, marked_by)
         VALUES (:courseId, :studentId, :date, :status, :note, :markedBy)
         ON CONFLICT (course_id, student_id, session_date)
         DO UPDATE SET status    = excluded.status,
                       note      = excluded.note,
                       marked_by = excluded.marked_by,
                       marked_at = datetime('now')`,
        { courseId, date, markedBy: req.user.id, ...record }
      );
    }
  });

  res.json({ ok: true, saved: prepared.length, date });
});

/** Change a single record, for a quick correction. */
attendanceRouter.patch('/:id', requireRoles('admin', 'teacher'), (req, res) => {
  const id = requireId(req.params.id);
  const record = get('SELECT * FROM attendance WHERE id = :id', { id });
  if (!record) throw notFound('Attendance record not found.');

  const course = loadCourse(record.course_id);
  assertCanMark(req.user, course);

  const updates = {};
  if (req.body?.status !== undefined) updates.status = requireStatus(req.body.status);
  if (req.body?.note !== undefined) updates.note = optionalString(req.body.note, 'note', { max: 500 });
  if (Object.keys(updates).length === 0) throw badRequest('No changes were provided.');

  const assignments = Object.keys(updates).map((column) => `${column} = :${column}`).join(', ');
  run(
    `UPDATE attendance
        SET ${assignments}, marked_by = :markedBy, marked_at = datetime('now')
      WHERE id = :id`,
    { ...updates, markedBy: req.user.id, id }
  );

  res.json({ record: get('SELECT * FROM attendance WHERE id = :id', { id }) });
});

attendanceRouter.delete('/:id', requireRoles('admin', 'teacher'), (req, res) => {
  const id = requireId(req.params.id);
  const record = get('SELECT * FROM attendance WHERE id = :id', { id });
  if (!record) throw notFound('Attendance record not found.');

  assertCanMark(req.user, loadCourse(record.course_id));
  run('DELETE FROM attendance WHERE id = :id', { id });
  res.json({ ok: true });
});

/**
 * Raw records with filters. Students are silently scoped to their own rows so
 * they cannot read anyone else's attendance.
 */
attendanceRouter.get('/', (req, res) => {
  const clauses = [];
  const params = {};

  const courseId = req.query.courseId ? requireId(req.query.courseId, 'courseId') : null;
  if (courseId) {
    const course = loadCourse(courseId);
    if (req.user.role === 'teacher' && !canManageCourse(req.user, course)) {
      throw forbidden('You do not teach this course.');
    }
    clauses.push('a.course_id = :courseId');
    params.courseId = courseId;
  }

  if (req.user.role === 'student') {
    clauses.push('a.student_id = :selfId');
    params.selfId = req.user.id;
  } else {
    if (req.query.studentId) {
      params.studentId = requireId(req.query.studentId, 'studentId');
      clauses.push('a.student_id = :studentId');
    }
    if (req.user.role === 'teacher') {
      clauses.push('a.course_id IN (SELECT id FROM courses WHERE teacher_id = :selfId)');
      params.selfId = req.user.id;
    }
  }

  const from = optionalDate(req.query.from, 'from');
  const to = optionalDate(req.query.to, 'to');
  if (from) {
    clauses.push('a.session_date >= :from');
    params.from = from;
  }
  if (to) {
    clauses.push('a.session_date <= :to');
    params.to = to;
  }
  if (req.query.status) {
    params.status = requireStatus(req.query.status);
    clauses.push('a.status = :status');
  }

  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const records = all(
    `SELECT a.id,
            a.session_date AS date,
            a.status,
            a.note,
            a.marked_at    AS markedAt,
            c.id           AS courseId,
            c.code         AS courseCode,
            c.name         AS courseName,
            u.id           AS studentId,
            u.name         AS studentName,
            u.roll_number  AS rollNumber
       FROM attendance a
       JOIN courses c ON c.id = a.course_id
       JOIN users   u ON u.id = a.student_id
       ${where}
       ORDER BY a.session_date DESC, c.code, IFNULL(u.roll_number, u.name)
       LIMIT 1000`,
    params
  );

  res.json({ records });
});

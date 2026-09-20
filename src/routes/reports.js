import { Router } from 'express';
import { all, get } from '../db/index.js';
import { authenticate, canManageCourse, requireRoles } from '../middleware/auth.js';
import { forbidden, notFound } from '../utils/errors.js';
import { loadCourse } from './courses.js';
import { optionalDate, optionalId, requireId } from '../utils/validate.js';

export const reportsRouter = Router();

reportsRouter.use(authenticate);

/** Percentage of sessions counted as attended, rounded to one decimal. */
function attendanceRate({ present = 0, late = 0, excused = 0, totalSessions = 0 }) {
  const counted = totalSessions - excused;
  if (counted <= 0) return null;
  return Math.round(((present + late) / counted) * 1000) / 10;
}

const SUMMARY_COLUMNS = `
  COUNT(a.id)                                           AS totalSessions,
  SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present,
  SUM(CASE WHEN a.status = 'absent'  THEN 1 ELSE 0 END) AS absent,
  SUM(CASE WHEN a.status = 'late'    THEN 1 ELSE 0 END) AS late,
  SUM(CASE WHEN a.status = 'excused' THEN 1 ELSE 0 END) AS excused`;

/** Headline numbers for the dashboard, shaped by the caller's role. */
reportsRouter.get('/dashboard', (req, res) => {
  const { role, id } = req.user;

  if (role === 'admin') {
    const counts = get(`
      SELECT (SELECT COUNT(*) FROM users   WHERE role = 'student' AND is_active = 1) AS students,
             (SELECT COUNT(*) FROM users   WHERE role = 'teacher' AND is_active = 1) AS teachers,
             (SELECT COUNT(*) FROM courses WHERE is_active = 1)                      AS courses,
             (SELECT COUNT(*) FROM attendance)                                       AS records`);

    const overall = get(`SELECT ${SUMMARY_COLUMNS} FROM attendance a`);

    const recent = all(`
      SELECT a.session_date AS date, ${SUMMARY_COLUMNS}
        FROM attendance a
       GROUP BY a.session_date
       ORDER BY a.session_date DESC
       LIMIT 14`);

    const byCourse = all(`
      SELECT c.id, c.code, c.name, ${SUMMARY_COLUMNS}
        FROM courses c
        LEFT JOIN attendance a ON a.course_id = c.id
       WHERE c.is_active = 1
       GROUP BY c.id
       ORDER BY c.code`);

    return res.json({
      role,
      counts,
      overall: { ...overall, rate: attendanceRate(overall) },
      recent: recent.reverse().map((row) => ({ ...row, rate: attendanceRate(row) })),
      byCourse: byCourse.map((row) => ({ ...row, rate: attendanceRate(row) }))
    });
  }

  if (role === 'teacher') {
    const byCourse = all(
      `SELECT c.id, c.code, c.name, ${SUMMARY_COLUMNS},
              (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id) AS studentCount
         FROM courses c
         LEFT JOIN attendance a ON a.course_id = c.id
        WHERE c.teacher_id = :id
        GROUP BY c.id
        ORDER BY c.code`,
      { id }
    );

    const overall = get(
      `SELECT ${SUMMARY_COLUMNS}
         FROM attendance a
        WHERE a.course_id IN (SELECT id FROM courses WHERE teacher_id = :id)`,
      { id }
    );

    return res.json({
      role,
      counts: {
        courses: byCourse.length,
        students: get(
          `SELECT COUNT(DISTINCT e.student_id) AS n
             FROM enrollments e
            WHERE e.course_id IN (SELECT id FROM courses WHERE teacher_id = :id)`,
          { id }
        ).n,
        records: overall.totalSessions
      },
      overall: { ...overall, rate: attendanceRate(overall) },
      byCourse: byCourse.map((row) => ({ ...row, rate: attendanceRate(row) }))
    });
  }

  // Student view: their own numbers only.
  const byCourse = all(
    `SELECT c.id, c.code, c.name, ${SUMMARY_COLUMNS}
       FROM enrollments e
       JOIN courses c ON c.id = e.course_id
       LEFT JOIN attendance a ON a.course_id = c.id AND a.student_id = :id
      WHERE e.student_id = :id
      GROUP BY c.id
      ORDER BY c.code`,
    { id }
  );

  const overall = get(`SELECT ${SUMMARY_COLUMNS} FROM attendance a WHERE a.student_id = :id`, { id });

  const recent = all(
    `SELECT a.session_date AS date, a.status, c.code AS courseCode, c.name AS courseName
       FROM attendance a
       JOIN courses c ON c.id = a.course_id
      WHERE a.student_id = :id
      ORDER BY a.session_date DESC, c.code
      LIMIT 20`,
    { id }
  );

  res.json({
    role,
    counts: { courses: byCourse.length, records: overall.totalSessions },
    overall: { ...overall, rate: attendanceRate(overall) },
    byCourse: byCourse.map((row) => ({ ...row, rate: attendanceRate(row) })),
    recent
  });
});

/** Per-student totals for one course, used by the reports screen. */
reportsRouter.get('/course/:id', requireRoles('admin', 'teacher'), (req, res) => {
  const course = loadCourse(requireId(req.params.id));
  if (!canManageCourse(req.user, course)) {
    throw forbidden('You do not teach this course.');
  }

  const from = optionalDate(req.query.from, 'from');
  const to = optionalDate(req.query.to, 'to');

  const dateFilter = [
    from ? 'AND a.session_date >= :from' : '',
    to ? 'AND a.session_date <= :to' : ''
  ].join(' ');

  const students = all(
    `SELECT u.id,
            u.name,
            u.roll_number AS rollNumber,
            ${SUMMARY_COLUMNS}
       FROM enrollments e
       JOIN users u ON u.id = e.student_id
       LEFT JOIN attendance a
              ON a.student_id = u.id AND a.course_id = e.course_id ${dateFilter}
      WHERE e.course_id = :courseId
      GROUP BY u.id
      ORDER BY IFNULL(u.roll_number, u.name)`,
    { courseId: course.id, ...(from ? { from } : {}), ...(to ? { to } : {}) }
  );

  const sessions = all(
    `SELECT DISTINCT a.session_date AS date
       FROM attendance a
      WHERE a.course_id = :courseId ${dateFilter}
      ORDER BY a.session_date DESC`,
    { courseId: course.id, ...(from ? { from } : {}), ...(to ? { to } : {}) }
  ).map((row) => row.date);

  res.json({
    course,
    sessions,
    students: students.map((row) => ({ ...row, rate: attendanceRate(row) }))
  });
});

/** One student's record across every course they are enrolled in. */
reportsRouter.get('/student/:id', (req, res) => {
  const studentId = requireId(req.params.id);

  if (req.user.role === 'student' && req.user.id !== studentId) {
    throw forbidden('You can only view your own attendance.');
  }

  const student = get(
    `SELECT id, name, email, roll_number AS rollNumber, department
       FROM users WHERE id = :studentId AND role = 'student'`,
    { studentId }
  );
  if (!student) throw notFound('Student not found.');

  const byCourse = all(
    `SELECT c.id, c.code, c.name, ${SUMMARY_COLUMNS}
       FROM enrollments e
       JOIN courses c ON c.id = e.course_id
       LEFT JOIN attendance a ON a.course_id = c.id AND a.student_id = :studentId
      WHERE e.student_id = :studentId
      GROUP BY c.id
      ORDER BY c.code`,
    { studentId }
  );

  const overall = get(
    `SELECT ${SUMMARY_COLUMNS} FROM attendance a WHERE a.student_id = :studentId`,
    { studentId }
  );

  res.json({
    student,
    overall: { ...overall, rate: attendanceRate(overall) },
    byCourse: byCourse.map((row) => ({ ...row, rate: attendanceRate(row) }))
  });
});

/** Everything the reports screen shows, as a CSV download. */
reportsRouter.get('/export.csv', requireRoles('admin', 'teacher'), (req, res) => {
  const courseId = optionalId(req.query.courseId, 'courseId');
  const from = optionalDate(req.query.from, 'from');
  const to = optionalDate(req.query.to, 'to');

  const clauses = [];
  const params = {};

  if (courseId) {
    const course = loadCourse(courseId);
    if (!canManageCourse(req.user, course)) throw forbidden('You do not teach this course.');
    clauses.push('a.course_id = :courseId');
    params.courseId = courseId;
  } else if (req.user.role === 'teacher') {
    clauses.push('a.course_id IN (SELECT id FROM courses WHERE teacher_id = :selfId)');
    params.selfId = req.user.id;
  }

  if (from) {
    clauses.push('a.session_date >= :from');
    params.from = from;
  }
  if (to) {
    clauses.push('a.session_date <= :to');
    params.to = to;
  }

  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const rows = all(
    `SELECT a.session_date AS date,
            c.code         AS courseCode,
            c.name         AS courseName,
            u.roll_number  AS rollNumber,
            u.name         AS studentName,
            a.status,
            IFNULL(a.note, '') AS note,
            IFNULL(m.name, '') AS markedBy
       FROM attendance a
       JOIN courses c ON c.id = a.course_id
       JOIN users   u ON u.id = a.student_id
       LEFT JOIN users m ON m.id = a.marked_by
       ${where}
       ORDER BY a.session_date DESC, c.code, IFNULL(u.roll_number, u.name)`,
    params
  );

  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };

  const header = ['Date', 'Course Code', 'Course Name', 'Roll Number', 'Student', 'Status', 'Note', 'Marked By'];
  const csv = [
    header.join(','),
    ...rows.map((row) =>
      [row.date, row.courseCode, row.courseName, row.rollNumber, row.studentName, row.status, row.note, row.markedBy]
        .map(escape)
        .join(',')
    )
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${Date.now()}.csv"`);
  res.send(csv);
});

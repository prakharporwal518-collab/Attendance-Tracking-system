PRAGMA foreign_keys = ON;

-- Every person who can sign in. Students and teachers both live here so that
-- authentication has a single source of truth.
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  email          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT    NOT NULL,
  role           TEXT    NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
  roll_number    TEXT    UNIQUE,          -- students only
  department     TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- A subject/class taught by one teacher.
CREATE TABLE IF NOT EXISTS courses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name         TEXT    NOT NULL,
  department   TEXT,
  teacher_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Which students belong to which course.
CREATE TABLE IF NOT EXISTS enrollments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_id  INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (course_id, student_id)
);

-- One row per student, per course, per day.
CREATE TABLE IF NOT EXISTS attendance (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id     INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_id    INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  session_date  TEXT    NOT NULL,          -- YYYY-MM-DD
  status        TEXT    NOT NULL CHECK (status IN ('present', 'absent', 'late', 'excused')),
  note          TEXT,
  marked_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  marked_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (course_id, student_id, session_date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_course_date ON attendance (course_id, session_date);
CREATE INDEX IF NOT EXISTS idx_attendance_student     ON attendance (student_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_student    ON enrollments (student_id);
CREATE INDEX IF NOT EXISTS idx_courses_teacher        ON courses (teacher_id);

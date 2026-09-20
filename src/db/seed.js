/**
 * Creates a small but realistic dataset so the app is usable the moment it
 * starts: three roles, five courses, twenty-four students and roughly six
 * weeks of attendance history.
 *
 *   npm run seed     add demo data, keeping anything already there
 *   npm run reset    wipe every table first, then seed
 */
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { all, get, run, transaction } from './index.js';

const RESET = process.argv.includes('--reset');

const FIRST_NAMES = [
  'Aarav', 'Ananya', 'Rohan', 'Ishita', 'Kabir', 'Meera', 'Arjun', 'Diya',
  'Vivaan', 'Saanvi', 'Aditya', 'Priya', 'Karan', 'Nisha', 'Rahul', 'Tanvi',
  'Siddharth', 'Riya', 'Manav', 'Kavya', 'Dev', 'Sneha', 'Yash', 'Pooja'
];
const LAST_NAMES = [
  'Sharma', 'Verma', 'Patel', 'Reddy', 'Nair', 'Iyer', 'Gupta', 'Joshi',
  'Mehta', 'Singh', 'Chopra', 'Desai'
];

const TEACHERS = [
  { name: 'Dr. Sunita Rao', email: 'sunita.rao@college.edu', department: 'Computer Science' },
  { name: 'Prof. Anil Kumar', email: 'anil.kumar@college.edu', department: 'Computer Science' },
  { name: 'Dr. Fatima Sheikh', email: 'fatima.sheikh@college.edu', department: 'Mathematics' }
];

const COURSES = [
  { code: 'CS201', name: 'Data Structures and Algorithms', department: 'Computer Science', teacher: 0 },
  { code: 'CS202', name: 'Database Management Systems', department: 'Computer Science', teacher: 0 },
  { code: 'CS203', name: 'Operating Systems', department: 'Computer Science', teacher: 1 },
  { code: 'CS204', name: 'Web Development', department: 'Computer Science', teacher: 1 },
  { code: 'MA201', name: 'Discrete Mathematics', department: 'Mathematics', teacher: 2 }
];

/** Deterministic pseudo-random generator so every seed run looks the same. */
function makeRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const random = makeRandom(20260920);

/** The last `count` weekdays, oldest first, as YYYY-MM-DD. */
function recentWeekdays(count) {
  const dates = [];
  const cursor = new Date();
  cursor.setHours(12, 0, 0, 0);

  while (dates.length < count) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return dates.reverse();
}

function wipe() {
  console.log('Clearing existing data…');
  for (const table of ['attendance', 'enrollments', 'courses', 'users']) {
    run(`DELETE FROM ${table}`);
  }
  run("DELETE FROM sqlite_sequence WHERE name IN ('attendance','enrollments','courses','users')");
}

async function seed() {
  if (RESET) wipe();

  if (get('SELECT COUNT(*) AS n FROM users').n > 0) {
    console.log('The database already has users. Run "npm run reset" to start over.');
    return;
  }

  const passwordHash = await bcrypt.hash(config.seedPassword, 10);

  const createUser = (name, email, role, rollNumber, department) =>
    Number(
      run(
        `INSERT INTO users (name, email, password_hash, role, roll_number, department)
         VALUES (:name, :email, :passwordHash, :role, :rollNumber, :department)`,
        { name, email, passwordHash, role, rollNumber, department }
      ).lastInsertRowid
    );

  transaction(() => {
    createUser('System Administrator', 'admin@college.edu', 'admin', null, 'Administration');

    const teacherIds = TEACHERS.map((teacher) =>
      createUser(teacher.name, teacher.email, 'teacher', null, teacher.department)
    );

    const studentIds = FIRST_NAMES.map((first, index) => {
      const last = LAST_NAMES[index % LAST_NAMES.length];
      const roll = `CS22${String(index + 1).padStart(3, '0')}`;
      const email = `${first.toLowerCase()}.${last.toLowerCase()}${index + 1}@student.college.edu`;
      return createUser(`${first} ${last}`, email, 'student', roll, 'Computer Science');
    });

    const courseIds = COURSES.map((course) =>
      Number(
        run(
          `INSERT INTO courses (code, name, department, teacher_id)
           VALUES (:code, :name, :department, :teacherId)`,
          {
            code: course.code,
            name: course.name,
            department: course.department,
            teacherId: teacherIds[course.teacher]
          }
        ).lastInsertRowid
      )
    );

    // Everyone takes the first three courses; the rest get a subset so the
    // reports have some variety in class size.
    const rosters = courseIds.map((courseId, index) => {
      const roster = index < 3
        ? studentIds
        : studentIds.filter((_, position) => (position + index) % 3 !== 0);

      for (const studentId of roster) {
        run(
          'INSERT INTO enrollments (course_id, student_id) VALUES (:courseId, :studentId)',
          { courseId, studentId }
        );
      }
      return { courseId, roster, teacherId: teacherIds[COURSES[index].teacher] };
    });

    // Give each student a stable "reliability" so the history looks like real
    // people rather than uniform noise. The range deliberately reaches below
    // the 75% pass mark so the at-risk highlighting has something to show.
    const reliability = new Map(
      studentIds.map((studentId) => [studentId, 0.58 + random() * 0.4])
    );

    const dates = recentWeekdays(30);
    let marked = 0;

    for (const { courseId, roster, teacherId } of rosters) {
      for (const date of dates) {
        // A course does not meet every single weekday.
        if (random() < 0.35) continue;

        for (const studentId of roster) {
          const roll = random();
          const threshold = reliability.get(studentId);

          // Everything above a student's reliability becomes a small band of
          // late/excused, then absent for the rest.
          let status = 'present';
          if (roll >= threshold + 0.1) status = 'absent';
          else if (roll >= threshold + 0.06) status = 'excused';
          else if (roll >= threshold) status = 'late';

          run(
            `INSERT INTO attendance (course_id, student_id, session_date, status, note, marked_by)
             VALUES (:courseId, :studentId, :date, :status, :note, :teacherId)`,
            {
              courseId,
              studentId,
              date,
              status,
              note: status === 'excused' ? 'Medical leave' : null,
              teacherId
            }
          );
          marked += 1;
        }
      }
    }

    console.log(`Created ${studentIds.length} students, ${teacherIds.length} teachers,`);
    console.log(`${courseIds.length} courses and ${marked} attendance records.`);
  });

  console.log('\nDemo accounts (password: %s)', config.seedPassword);
  console.log('  admin    admin@college.edu');
  console.log('  teacher  sunita.rao@college.edu');
  const firstStudent = all("SELECT email FROM users WHERE role = 'student' ORDER BY id LIMIT 1")[0];
  console.log(`  student  ${firstStudent.email}\n`);
}

seed().catch((error) => {
  console.error('Seeding failed:', error);
  process.exit(1);
});

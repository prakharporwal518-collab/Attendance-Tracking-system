# Attendance Tracking System

A web application for recording and reporting student attendance in a college or
school. Teachers mark a class in one pass, students see their own percentage, and
administrators manage people, courses and rosters.

![Node](https://img.shields.io/badge/node-%E2%89%A522.5-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

## Quick start

```bash
git clone https://github.com/prakharporwal518-collab/Attendance-Tracking-system.git
cd Attendance-Tracking-system

npm install      # install dependencies
npm run seed     # create the database with demo data
npm start        # http://localhost:3000
```

Then open <http://localhost:3000> and sign in with one of the demo accounts
(password `password123` for all three):

| Role    | Email                               | What they can do                          |
| ------- | ----------------------------------- | ----------------------------------------- |
| Admin   | `admin@college.edu`                 | Everything: people, courses, all reports   |
| Teacher | `sunita.rao@college.edu`            | Mark and report on their own courses       |
| Student | `aarav.sharma1@student.college.edu` | View their own attendance                  |

> The demo accounts exist only in the seeded database. Delete `data/` and run
> `npm run seed` again to start over, or `npm run reset` to wipe and reseed.

## Features

**Taking attendance**
- One screen per course and date, with the whole roster on it
- Four statuses: present, absent, late, excused
- "Mark all present", then change only the exceptions
- Saving the same date again updates the existing marks instead of duplicating them
- Optional per-student note (for example "medical leave")

**Reporting**
- Dashboard tailored to each role, with a daily attendance-rate chart
- Per-course report with every student's percentage, filterable by date range
- Students below the 75% mark are flagged
- CSV export of any filtered view

**Administration**
- Create students, teachers and administrators
- Create courses and assign a teacher
- Manage a course roster with a searchable checklist
- Deactivate an account to block sign-in while keeping its history

**Throughout**
- Role-based access enforced on the server, not just hidden in the UI
- Works on a phone as well as a laptop

## How attendance percentage is calculated

```
rate = (present + late) / (total sessions − excused)
```

Arriving late still counts as attending. Excused sessions are left out of the
calculation entirely rather than counted against the student, so one authorised
absence does not lower their percentage. A student with no recorded sessions has
no rate at all (shown as "No sessions yet") rather than 0%.

## Project layout

```
src/
  server.js            starts the HTTP server
  app.js               builds the Express app (routes, static files, errors)
  config.js            environment configuration
  db/
    schema.sql         table definitions
    index.js           database connection and query helpers
    seed.js            demo data
  middleware/
    auth.js            token verification and role checks
    error.js           turns thrown errors into JSON responses
  routes/
    auth.js            login, logout, change password
    users.js           people management
    courses.js         courses and enrollment
    attendance.js      marking and reading attendance
    reports.js         dashboards, per-course reports, CSV export
  utils/
    validate.js        input validation
    errors.js          HTTP error types
public/
  index.html           single page that hosts the whole frontend
  css/styles.css
  js/
    api.js             fetch wrapper
    ui.js              DOM and formatting helpers
    app.js             routing and session handling
    views/             one module per screen
tests/
  api.test.js          end-to-end tests against a temporary database
```

## Tech stack

Deliberately small, so it runs anywhere Node does with no build step:

- **Node.js + Express 5** for the HTTP layer
- **SQLite** through Node's built-in `node:sqlite` — no native module to compile
- **bcrypt** for password hashing, **JWT** for sessions
- **Vanilla JavaScript ES modules** on the frontend — no bundler, no framework

## Scripts

| Command         | What it does                                          |
| --------------- | ----------------------------------------------------- |
| `npm start`     | Run the server                                         |
| `npm run dev`   | Run with auto-restart on file changes                  |
| `npm run seed`  | Create demo data (does nothing if users already exist) |
| `npm run reset` | Wipe every table, then seed                            |
| `npm test`      | Run the test suite                                     |

## Configuration

Copy `.env.example` to `.env` to change anything:

| Variable           | Default                  | Purpose                            |
| ------------------ | ------------------------ | ---------------------------------- |
| `PORT`             | `3000`                   | Port to listen on                  |
| `JWT_SECRET`       | dev-only placeholder     | Signs session tokens               |
| `TOKEN_EXPIRES_IN` | `8h`                     | How long a session lasts           |
| `DATABASE_FILE`    | `data/attendance.sqlite` | Where the database lives           |
| `SEED_PASSWORD`    | `password123`            | Password given to demo accounts    |

**Before deploying anywhere real:** set `JWT_SECRET` to a long random string and
`NODE_ENV=production` (the server refuses to start with the placeholder secret in
production), change the demo passwords, and put the app behind HTTPS — the
session cookie is only marked `Secure` when `NODE_ENV=production`.

## API

All endpoints live under `/api` and, except for login, require a session. The
token is sent either in an `httpOnly` cookie (what the web UI uses) or as an
`Authorization: Bearer <token>` header.

| Method   | Path                              | Who      |
| -------- | --------------------------------- | -------- |
| `POST`   | `/auth/login`                     | anyone   |
| `POST`   | `/auth/logout`                    | anyone   |
| `GET`    | `/auth/me`                        | any user |
| `POST`   | `/auth/change-password`           | any user |
| `GET`    | `/users`                          | staff    |
| `POST`   | `/users`                          | admin    |
| `PATCH`  | `/users/:id`                      | admin    |
| `DELETE` | `/users/:id`                      | admin    |
| `GET`    | `/courses`                        | any user |
| `POST`   | `/courses`                        | admin    |
| `PATCH`  | `/courses/:id`                    | admin    |
| `DELETE` | `/courses/:id`                    | admin    |
| `GET`    | `/courses/:id/students`           | staff    |
| `POST`   | `/courses/:id/students`           | staff    |
| `DELETE` | `/courses/:id/students/:studentId`| staff    |
| `GET`    | `/attendance/sheet`               | staff    |
| `POST`   | `/attendance/bulk`                | staff    |
| `GET`    | `/attendance`                     | any user |
| `PATCH`  | `/attendance/:id`                 | staff    |
| `DELETE` | `/attendance/:id`                 | staff    |
| `GET`    | `/reports/dashboard`              | any user |
| `GET`    | `/reports/course/:id`             | staff    |
| `GET`    | `/reports/student/:id`            | any user |
| `GET`    | `/reports/export.csv`             | staff    |

"Staff" means admin or teacher, and a teacher is further limited to the courses
they own. Students are silently scoped to their own rows on every endpoint they
can reach.

## Data model

```
users ──────┬──< enrollments >── courses
            │                       │
            └──────< attendance >───┘
```

- A **user** is a student, teacher or admin; all three sign in the same way.
- A **course** belongs to one teacher.
- An **enrollment** puts a student on a course roster.
- An **attendance** row is one student, on one course, on one date. A uniqueness
  constraint on that triple is what makes re-saving a sheet an update rather than
  a duplicate.

Deleting a course or a student removes their enrollments and attendance rows
through `ON DELETE CASCADE`. To keep the history instead, deactivate the account.

## Testing

```bash
npm test
```

The suite starts a real server against a temporary database and covers
authentication, role boundaries, marking rules (future dates, invalid statuses,
unenrolled students), percentage calculation, CSV export, and cascade deletes.

## License

MIT

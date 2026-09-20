import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { get } from '../db/index.js';
import { forbidden, unauthorized } from '../utils/errors.js';

/** Issue a signed token for a freshly authenticated user. */
export function issueToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, name: user.name },
    config.jwtSecret,
    { expiresIn: config.tokenExpiresIn }
  );
}

/** Pull the bearer token from the Authorization header or the auth cookie. */
function readToken(req) {
  const header = req.get('authorization');
  if (header && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  return req.cookies?.token ?? null;
}

/**
 * Verify the caller's token and attach the live user row to `req.user`.
 * The row is re-read on every request so a deactivated account loses access
 * immediately instead of when its token happens to expire.
 */
export function authenticate(req, _res, next) {
  const token = readToken(req);
  if (!token) return next(unauthorized());

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return next(unauthorized('Your session has expired. Please sign in again.'));
  }

  const user = get(
    `SELECT id, name, email, role, roll_number, department, is_active
       FROM users WHERE id = :id`,
    { id: payload.sub }
  );

  if (!user || user.is_active !== 1) {
    return next(unauthorized('This account is no longer active.'));
  }

  req.user = user;
  next();
}

/** Restrict a route to the listed roles. Use after `authenticate`. */
export function requireRoles(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(forbidden(`This action is limited to: ${roles.join(', ')}.`));
    }
    next();
  };
}

/**
 * True when the teacher owns the course, or the caller is an admin.
 * Course rows reach this function both as raw table rows (`teacher_id`) and as
 * the aliased shape the API returns (`teacherId`), so accept either spelling.
 */
export function canManageCourse(user, course) {
  if (!course) return false;
  if (user.role === 'admin') return true;

  const teacherId = course.teacherId ?? course.teacher_id ?? null;
  return user.role === 'teacher' && teacherId === user.id;
}

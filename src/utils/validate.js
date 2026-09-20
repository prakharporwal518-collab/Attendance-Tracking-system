import { badRequest } from './errors.js';

export const ROLES = ['admin', 'teacher', 'student'];
export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'excused'];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim a string field and fail when it is missing or empty. */
export function requireString(value, field, { max = 200 } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`"${field}" is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw badRequest(`"${field}" must be ${max} characters or fewer.`);
  }
  return trimmed;
}

/** Trim an optional string, returning null when it is absent or blank. */
export function optionalString(value, field, { max = 200 } = {}) {
  if (value === undefined || value === null || value === '') return null;
  return requireString(value, field, { max });
}

export function requireEmail(value) {
  const email = requireString(value, 'email').toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw badRequest('Please provide a valid email address.');
  }
  return email;
}

export function requirePassword(value) {
  if (typeof value !== 'string' || value.length < 8) {
    throw badRequest('Password must be at least 8 characters long.');
  }
  if (value.length > 200) {
    throw badRequest('Password must be 200 characters or fewer.');
  }
  return value;
}

export function requireRole(value) {
  const role = requireString(value, 'role').toLowerCase();
  if (!ROLES.includes(role)) {
    throw badRequest(`"role" must be one of: ${ROLES.join(', ')}.`);
  }
  return role;
}

export function requireStatus(value) {
  const status = requireString(value, 'status').toLowerCase();
  if (!ATTENDANCE_STATUSES.includes(status)) {
    throw badRequest(`"status" must be one of: ${ATTENDANCE_STATUSES.join(', ')}.`);
  }
  return status;
}

/**
 * Validate a YYYY-MM-DD date. The round-trip through Date catches values that
 * match the pattern but are not real days, such as 2026-02-31.
 */
export function requireDate(value, field = 'date') {
  const date = requireString(value, field, { max: 10 });
  if (!DATE_PATTERN.test(date)) {
    throw badRequest(`"${field}" must use the YYYY-MM-DD format.`);
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw badRequest(`"${field}" is not a real calendar date.`);
  }
  return date;
}

export function optionalDate(value, field = 'date') {
  if (value === undefined || value === null || value === '') return null;
  return requireDate(value, field);
}

/** Parse a positive integer id coming from a URL parameter or body field. */
export function requireId(value, field = 'id') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest(`"${field}" must be a positive whole number.`);
  }
  return id;
}

export function optionalId(value, field = 'id') {
  if (value === undefined || value === null || value === '') return null;
  return requireId(value, field);
}

/** Today's date in the server's local timezone, as YYYY-MM-DD. */
export function today() {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

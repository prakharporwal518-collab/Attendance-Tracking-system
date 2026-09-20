import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { all, get, run } from '../db/index.js';
import { authenticate, requireRoles } from '../middleware/auth.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import {
  optionalString,
  requireEmail,
  requireId,
  requirePassword,
  requireRole,
  requireString
} from '../utils/validate.js';

export const usersRouter = Router();

usersRouter.use(authenticate);

const SELECT_USER = `
  SELECT id, name, email, role, roll_number AS rollNumber,
         department, is_active AS isActive, created_at AS createdAt
    FROM users`;

/** List users, optionally filtered by role or a search term. */
usersRouter.get('/', requireRoles('admin', 'teacher'), (req, res) => {
  const clauses = [];
  const params = {};

  if (req.query.role) {
    params.role = requireRole(req.query.role);
    clauses.push('role = :role');
  }
  if (req.query.search) {
    params.search = `%${requireString(req.query.search, 'search')}%`;
    clauses.push(
      "(name LIKE :search OR email LIKE :search OR IFNULL(roll_number, '') LIKE :search)"
    );
  }
  if (req.query.activeOnly === 'true') {
    clauses.push('is_active = 1');
  }

  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const users = all(`${SELECT_USER}${where} ORDER BY role, name`, params);
  res.json({ users });
});

usersRouter.get('/:id', (req, res) => {
  const id = requireId(req.params.id);

  // A student may only read their own record; staff may read anyone's.
  if (req.user.role === 'student' && req.user.id !== id) {
    throw notFound('User not found.');
  }

  const user = get(`${SELECT_USER} WHERE id = :id`, { id });
  if (!user) throw notFound('User not found.');
  res.json({ user });
});

usersRouter.post('/', requireRoles('admin'), async (req, res) => {
  const name = requireString(req.body?.name, 'name');
  const email = requireEmail(req.body?.email);
  const role = requireRole(req.body?.role);
  const password = requirePassword(req.body?.password);
  const department = optionalString(req.body?.department, 'department');
  const rollNumber = role === 'student'
    ? optionalString(req.body?.rollNumber, 'rollNumber', { max: 50 })
    : null;

  if (get('SELECT id FROM users WHERE email = :email', { email })) {
    throw conflict('A user with that email already exists.');
  }
  if (rollNumber && get('SELECT id FROM users WHERE roll_number = :rollNumber', { rollNumber })) {
    throw conflict('A student with that roll number already exists.');
  }

  const password_hash = await bcrypt.hash(password, 10);
  const { lastInsertRowid } = run(
    `INSERT INTO users (name, email, password_hash, role, roll_number, department)
     VALUES (:name, :email, :password_hash, :role, :rollNumber, :department)`,
    { name, email, password_hash, role, rollNumber, department }
  );

  const user = get(`${SELECT_USER} WHERE id = :id`, { id: Number(lastInsertRowid) });
  res.status(201).json({ user });
});

usersRouter.patch('/:id', requireRoles('admin'), async (req, res) => {
  const id = requireId(req.params.id);
  const existing = get('SELECT * FROM users WHERE id = :id', { id });
  if (!existing) throw notFound('User not found.');

  const updates = {};

  if (req.body?.name !== undefined) updates.name = requireString(req.body.name, 'name');
  if (req.body?.department !== undefined) {
    updates.department = optionalString(req.body.department, 'department');
  }
  if (req.body?.email !== undefined) {
    const email = requireEmail(req.body.email);
    const clash = get('SELECT id FROM users WHERE email = :email AND id != :id', { email, id });
    if (clash) throw conflict('Another user already uses that email.');
    updates.email = email;
  }
  if (req.body?.rollNumber !== undefined) {
    const rollNumber = optionalString(req.body.rollNumber, 'rollNumber', { max: 50 });
    if (rollNumber) {
      const clash = get(
        'SELECT id FROM users WHERE roll_number = :rollNumber AND id != :id',
        { rollNumber, id }
      );
      if (clash) throw conflict('Another student already uses that roll number.');
    }
    updates.roll_number = rollNumber;
  }
  if (req.body?.isActive !== undefined) {
    if (typeof req.body.isActive !== 'boolean') {
      throw badRequest('"isActive" must be true or false.');
    }
    if (!req.body.isActive && id === req.user.id) {
      throw badRequest('You cannot deactivate your own account.');
    }
    updates.is_active = req.body.isActive ? 1 : 0;
  }
  if (req.body?.password !== undefined) {
    updates.password_hash = await bcrypt.hash(requirePassword(req.body.password), 10);
  }
  if (req.body?.role !== undefined) {
    const role = requireRole(req.body.role);
    if (role !== existing.role && id === req.user.id) {
      throw badRequest('You cannot change your own role.');
    }
    if (role !== 'student') updates.roll_number = null;
    updates.role = role;
  }

  if (Object.keys(updates).length === 0) {
    throw badRequest('No changes were provided.');
  }

  const assignments = Object.keys(updates).map((column) => `${column} = :${column}`).join(', ');
  run(`UPDATE users SET ${assignments} WHERE id = :id`, { ...updates, id });

  res.json({ user: get(`${SELECT_USER} WHERE id = :id`, { id }) });
});

usersRouter.delete('/:id', requireRoles('admin'), (req, res) => {
  const id = requireId(req.params.id);
  if (id === req.user.id) throw badRequest('You cannot delete your own account.');

  const existing = get('SELECT id FROM users WHERE id = :id', { id });
  if (!existing) throw notFound('User not found.');

  // Enrollments and attendance rows cascade away with the student.
  run('DELETE FROM users WHERE id = :id', { id });
  res.json({ ok: true });
});

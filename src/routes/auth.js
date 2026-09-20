import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { get, run } from '../db/index.js';
import { authenticate, issueToken } from '../middleware/auth.js';
import { unauthorized, badRequest } from '../utils/errors.js';
import { requireEmail, requirePassword, requireString } from '../utils/validate.js';

export const authRouter = Router();

const publicUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  rollNumber: user.roll_number ?? null,
  department: user.department ?? null
});

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProduction,
  maxAge: 8 * 60 * 60 * 1000
};

authRouter.post('/login', async (req, res) => {
  const email = requireEmail(req.body?.email);
  const password = requireString(req.body?.password, 'password', { max: 200 });

  const user = get('SELECT * FROM users WHERE email = :email', { email });

  // Compare against a dummy hash when the user is missing so that a wrong
  // email and a wrong password take the same amount of time to answer.
  const hash = user?.password_hash ?? '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = await bcrypt.compare(password, hash);

  if (!user || !ok) {
    throw unauthorized('Email or password is incorrect.');
  }
  if (user.is_active !== 1) {
    throw unauthorized('This account has been deactivated. Please contact an administrator.');
  }

  const token = issueToken(user);
  res.cookie('token', token, cookieOptions);
  res.json({ token, user: publicUser(user) });
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie('token', { ...cookieOptions, maxAge: undefined });
  res.json({ ok: true });
});

authRouter.get('/me', authenticate, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

authRouter.post('/change-password', authenticate, async (req, res) => {
  const currentPassword = requireString(req.body?.currentPassword, 'currentPassword', { max: 200 });
  const newPassword = requirePassword(req.body?.newPassword);

  if (currentPassword === newPassword) {
    throw badRequest('The new password must be different from the current one.');
  }

  const row = get('SELECT password_hash FROM users WHERE id = :id', { id: req.user.id });
  const ok = await bcrypt.compare(currentPassword, row.password_hash);
  if (!ok) throw unauthorized('Your current password is incorrect.');

  const password_hash = await bcrypt.hash(newPassword, 10);
  run('UPDATE users SET password_hash = :password_hash WHERE id = :id', {
    password_hash,
    id: req.user.id
  });

  res.json({ ok: true });
});

export { publicUser };

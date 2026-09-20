import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { get } from './db/index.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { coursesRouter } from './routes/courses.js';
import { attendanceRouter } from './routes/attendance.js';
import { reportsRouter } from './routes/reports.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');

  // Render and similar hosts terminate TLS and forward over plain HTTP. Without
  // this, Express sees every request as insecure and req.ip is the proxy's.
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // A small set of headers that cost nothing and block the obvious attacks.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      time: new Date().toISOString(),
      // The login screen uses this to explain an empty database instead of
      // advertising demo accounts that do not exist.
      setupRequired: get('SELECT COUNT(*) AS n FROM users').n === 0
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/courses', coursesRouter);
  app.use('/api/attendance', attendanceRouter);
  app.use('/api/reports', reportsRouter);

  app.use('/api', notFoundHandler);

  app.use(express.static(config.publicDir));

  // Anything else is handled by the single-page frontend.
  app.use((_req, res) => {
    res.sendFile('index.html', { root: config.publicDir });
  });

  app.use(errorHandler);

  return app;
}

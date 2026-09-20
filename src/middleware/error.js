import { HttpError } from '../utils/errors.js';

/** Final handler: turn anything thrown in a route into a JSON response. */
export function errorHandler(error, _req, res, _next) {
  if (error instanceof HttpError) {
    return res.status(error.status).json({
      error: error.message,
      ...(error.details ? { details: error.details } : {})
    });
  }

  // SQLite surfaces constraint violations as plain errors; map the common ones
  // onto a 409 so the client can show something better than "server error".
  const message = String(error?.message ?? '');
  if (message.includes('UNIQUE constraint failed')) {
    return res.status(409).json({ error: 'That record already exists.' });
  }
  if (message.includes('FOREIGN KEY constraint failed')) {
    return res.status(400).json({ error: 'That record refers to something which does not exist.' });
  }

  console.error('[unhandled]', error);
  res.status(500).json({ error: 'Something went wrong on the server.' });
}

/** Catch-all for unknown /api paths. */
export function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'That API endpoint does not exist.' });
}

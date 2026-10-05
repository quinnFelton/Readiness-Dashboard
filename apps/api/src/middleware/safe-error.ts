import type { ErrorRequestHandler } from 'express';

// Security review L3: routers without their own error handler fell through to Express's default,
// which prints err.stack outside NODE_ENV=test and whose pg errors can quote row values (emails,
// health scalars). Mounted last in createApp: respond generically, log the error class name only
// (CLAUDE.md rule 6).
export const safeErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const e = err as { status?: unknown; type?: unknown };
  // body-parser errors (bad JSON, too large) carry a 4xx status and a safe fixed message class.
  if (typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
    res
      .status(e.status)
      .json({ error: e.type === 'entity.parse.failed' ? 'invalid_json' : 'bad_request' });
    return;
  }
  console.error(`unhandled request error: ${err instanceof Error ? err.name : 'error'}`);
  res.status(500).json({ error: 'internal error' });
};

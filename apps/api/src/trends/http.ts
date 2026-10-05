import type { ErrorRequestHandler } from 'express';
import { HttpError } from '../connections/errors';

// Small helpers shared by the phase-5b routers (trends, scores, feedback, athlete-events, comparison).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Strict, real calendar date (rejects 2026-02-30). */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === v;
}

export const MAX_RANGE_DAYS = 366;

/** `28d` → 28. Anything else is a 400 rather than a silent default. */
export function parseRangeDays(raw: unknown, fallbackDays: number): number {
  if (raw === undefined) return fallbackDays;
  const m = typeof raw === 'string' ? /^(\d{1,3})d$/.exec(raw) : null;
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_RANGE_DAYS) {
    throw new HttpError(400, `range must look like "28d" (1-${MAX_RANGE_DAYS} days)`);
  }
  return n;
}

export function addDays(date: string, days: number): string {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError('invalid date');
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

export const todayUtc = (now: Date): string => now.toISOString().slice(0, 10);

/**
 * Router-level error handler. It deliberately logs nothing about the error's message or object:
 * pg errors can quote the failing row (including `notes` / `comment`, CLAUDE.md rule 6) and Express's
 * default handler would print them. Only the class name goes to the log, at the call site's discretion.
 */
export const safeErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: 'internal error' });
};

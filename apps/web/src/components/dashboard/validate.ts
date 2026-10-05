// Input validation shared by the forms and the server actions. Messages are generic and never
// echo the user's free text (notes/comments are health-adjacent: never logged).
import {
  ATHLETE_EVENT_TYPES,
  type InsightVote,
  type PostAthleteEventBody,
  type PutFeedbackBody,
} from '@rd/shared-types';

export const MAX_COMMENT = 280;
export const MAX_NOTES = 500;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export type ActionResult = { ok: true } | { ok: false; error: string };

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateVote(input: unknown): Validated<PutFeedbackBody> {
  const i = (input ?? {}) as Record<string, unknown>;
  if (
    typeof i.classifierId !== 'string' ||
    i.classifierId.length === 0 ||
    i.classifierId.length > 100
  )
    return { ok: false, error: 'Invalid classifier.' };
  if (!isValidDate(i.asOf)) return { ok: false, error: 'Invalid date.' };
  if (i.vote !== 1 && i.vote !== -1) return { ok: false, error: 'Invalid vote.' };
  const comment = typeof i.comment === 'string' ? i.comment.trim() : '';
  if (comment.length > MAX_COMMENT)
    return { ok: false, error: `Comment must be ${MAX_COMMENT} characters or fewer.` };
  return {
    ok: true,
    value: {
      classifierId: i.classifierId,
      asOf: i.asOf,
      vote: i.vote as InsightVote,
      ...(comment ? { comment } : {}),
    },
  };
}

export function validateEvent(input: unknown): Validated<PostAthleteEventBody> {
  const i = (input ?? {}) as Record<string, unknown>;
  if (!isValidDate(i.date)) return { ok: false, error: 'Choose a valid date.' };
  if (!ATHLETE_EVENT_TYPES.includes(i.eventType as never))
    return { ok: false, error: 'Choose an event type.' };
  const notes = typeof i.notes === 'string' ? i.notes.trim() : '';
  if (notes.length > MAX_NOTES)
    return { ok: false, error: `Notes must be ${MAX_NOTES} characters or fewer.` };
  return {
    ok: true,
    value: {
      date: i.date,
      eventType: i.eventType as PostAthleteEventBody['eventType'],
      ...(notes ? { notes } : {}),
    },
  };
}

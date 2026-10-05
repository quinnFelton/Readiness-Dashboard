'use server';

// Server Actions for ratings and the event log. They run server-side, so the API token stays
// out of the browser. RBAC is still enforced by the API (self or master); a coach viewing an
// athlete passes that athlete's userId. Never log inputs: notes/comments are health-adjacent.
import { revalidatePath } from 'next/cache';
import { ApiError, deleteEvent, postEvent, putFeedback } from '../../components/dashboard/api';
import {
  validateEvent,
  validateVote,
  type ActionResult,
} from '../../components/dashboard/validate';

function failure(e: unknown): ActionResult {
  if (e instanceof ApiError && e.status === 403) return { ok: false, error: 'Not allowed.' };
  if (e instanceof ApiError && e.status === 404)
    return { ok: false, error: 'That insight is no longer available.' };
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

function refresh() {
  revalidatePath('/dashboard', 'layout');
  revalidatePath('/admin', 'layout');
}

export async function submitVote(userId: string, input: unknown): Promise<ActionResult> {
  const v = validateVote(input);
  if (!v.ok) return v;
  try {
    await putFeedback(userId, v.value);
  } catch (e) {
    return failure(e);
  }
  refresh();
  return { ok: true };
}

export async function logEvent(userId: string, input: unknown): Promise<ActionResult> {
  const v = validateEvent(input);
  if (!v.ok) return v;
  try {
    await postEvent(userId, v.value);
  } catch (e) {
    return failure(e);
  }
  refresh();
  return { ok: true };
}

export async function removeEvent(userId: string, eventId: string): Promise<ActionResult> {
  if (typeof eventId !== 'string' || eventId.length === 0)
    return { ok: false, error: 'Invalid event.' };
  try {
    await deleteEvent(userId, eventId);
  } catch (e) {
    return failure(e);
  }
  refresh();
  return { ok: true };
}

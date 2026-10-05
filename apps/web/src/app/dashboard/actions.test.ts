import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const api = vi.hoisted(() => ({
  putFeedback: vi.fn(),
  postEvent: vi.fn(),
  deleteEvent: vi.fn(),
}));
vi.mock('../../components/dashboard/api', () => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly path: string,
    ) {
      super(`API ${status} for ${path}`);
    }
  }
  return { ApiError, ...api };
});

import { ApiError } from '../../components/dashboard/api';
import { logEvent, removeEvent, submitVote } from './actions';

beforeEach(() => Object.values(api).forEach((f) => f.mockReset()));

describe('dashboard server actions', () => {
  it('votes for the athlete id passed (coach acting on an athlete)', async () => {
    api.putFeedback.mockResolvedValue(undefined);
    const r = await submitVote('athlete-9', {
      classifierId: 'c',
      asOf: '2026-09-27',
      vote: -1,
      comment: ' hi ',
    });
    expect(r).toEqual({ ok: true });
    expect(api.putFeedback).toHaveBeenCalledWith('athlete-9', {
      classifierId: 'c',
      asOf: '2026-09-27',
      vote: -1,
      comment: 'hi',
    });
  });

  it('rejects invalid votes without calling the API', async () => {
    for (const bad of [
      null,
      { classifierId: 'c', asOf: '2026-02-30', vote: 1 },
      { classifierId: 'c', asOf: '2026-09-27', vote: 0 },
      { classifierId: '', asOf: '2026-09-27', vote: 1 },
      { classifierId: 'c', asOf: '2026-09-27', vote: 1, comment: 'x'.repeat(281) },
    ]) {
      expect((await submitVote('u', bad)).ok).toBe(false);
    }
    expect(api.putFeedback).not.toHaveBeenCalled();
  });

  it('rejects invalid events without calling the API', async () => {
    expect((await logEvent('u', { date: '2026-09-27', eventType: 'party' })).ok).toBe(false);
    expect((await logEvent('u', { date: 'bad', eventType: 'race' })).ok).toBe(false);
    expect(
      (await logEvent('u', { date: '2026-09-27', eventType: 'race', notes: 'x'.repeat(501) })).ok,
    ).toBe(false);
    expect(api.postEvent).not.toHaveBeenCalled();
  });

  it('maps 403 to Not allowed', async () => {
    api.postEvent.mockRejectedValue(new ApiError(403, '/athlete-events/u'));
    const r = await logEvent('u', { date: '2026-09-27', eventType: 'illness', notes: 'secret' });
    expect(r).toEqual({ ok: false, error: 'Not allowed.' });
  });

  it('maps 404 and unexpected errors to generic messages', async () => {
    api.putFeedback.mockRejectedValueOnce(new ApiError(404, '/p'));
    const v = { classifierId: 'c', asOf: '2026-09-27', vote: 1 };
    expect(await submitVote('u', v)).toEqual({
      ok: false,
      error: 'That insight is no longer available.',
    });
    api.putFeedback.mockRejectedValueOnce(new Error('boom secret'));
    const r = await submitVote('u', v);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('secret');
  });

  it('never logs notes or comments on success or failure', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    api.postEvent.mockRejectedValueOnce(new Error('x'));
    await logEvent('u', { date: '2026-09-27', eventType: 'race', notes: 'PRIVATE' });
    api.putFeedback.mockResolvedValue(undefined);
    await submitVote('u', { classifierId: 'c', asOf: '2026-09-27', vote: 1, comment: 'PRIVATE' });
    for (const s of spies) {
      expect(JSON.stringify(s.mock.calls)).not.toContain('PRIVATE');
      s.mockRestore();
    }
  });

  it('removeEvent validates id and deletes under the athlete id', async () => {
    api.deleteEvent.mockResolvedValue(undefined);
    expect((await removeEvent('u', '')).ok).toBe(false);
    expect(api.deleteEvent).not.toHaveBeenCalled();
    expect(await removeEvent('athlete', 'e1')).toEqual({ ok: true });
    expect(api.deleteEvent).toHaveBeenCalledWith('athlete', 'e1');
  });
});

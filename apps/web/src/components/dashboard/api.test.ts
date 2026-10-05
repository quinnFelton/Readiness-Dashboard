import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const apiFetch = vi.fn();
vi.mock('../../lib/auth/api-fetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { ApiError, deleteEvent, getTrends, postEvent, putFeedback } from './api';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  apiFetch.mockReset();
  delete process.env.DASHBOARD_MOCK;
});

describe('dashboard api client', () => {
  it('GETs the trends route with an encoded user id and range', async () => {
    apiFetch.mockResolvedValue(json({ classifierId: 'c', trends: [], series: {} }));
    await getTrends('a/b', '90d');
    expect(apiFetch).toHaveBeenCalledWith('/trends/a%2Fb?range=90d');
  });

  it('throws an ApiError carrying status and path only', async () => {
    apiFetch.mockResolvedValue(json({ secret: 'health payload' }, 403));
    const err = await getTrends('u1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).message).not.toContain('health payload');
  });

  it('PUTs feedback and POSTs/DELETEs events with the right shapes', async () => {
    apiFetch.mockResolvedValue(json({}));
    await putFeedback('u1', { classifierId: 'c', asOf: '2026-09-27', vote: 1 });
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/feedback/u1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ classifierId: 'c', asOf: '2026-09-27', vote: 1 }),
      }),
    );
    await postEvent('u1', { date: '2026-09-20', eventType: 'illness' });
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/athlete-events/u1',
      expect.objectContaining({ method: 'POST' }),
    );
    await deleteEvent('u1', 'e1');
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/athlete-events/u1/e1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('serves fixtures without touching the network when DASHBOARD_MOCK is set', async () => {
    process.env.DASHBOARD_MOCK = '1';
    const t = await getTrends('u1');
    expect(t.trends.length).toBeGreaterThan(0);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

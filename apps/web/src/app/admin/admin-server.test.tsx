import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const apiFetch = vi.fn();
vi.mock('../../lib/auth/api-fetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
const auth = vi.fn();
vi.mock('../../lib/auth', () => ({ auth: () => auth() }));
const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));
const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchRoster', () => {
  it('uses latest fatigue state from trends when /users lacks it; tolerates per-athlete failure', async () => {
    const { fetchRoster } = await import('./_lib/api');
    apiFetch.mockImplementation(async (path: string) => {
      if (path === '/users')
        return json({
          users: [
            { id: 'a', email: 'a@x', name: 'A' },
            { id: 'b', email: 'b@x', name: 'B' },
          ],
        });
      if (path === '/trends/a')
        return json({
          trends: [
            { asOf: '2026-10-01', metricType: 'fatigue_fitness_state', state: 'fitness_gain' },
            { asOf: '2026-10-03', metricType: 'fatigue_fitness_state', state: 'overreaching_risk' },
            { asOf: '2026-10-04', metricType: 'ef', state: null },
          ],
        });
      return json({}, 500);
    });
    const rows = await fetchRoster();
    expect(rows[0]).toMatchObject({
      id: 'a',
      latestState: 'overreaching_risk',
      latestStateAsOf: '2026-10-03',
    });
    expect(rows[1]).toMatchObject({ id: 'b', latestState: null });
  });

  it('derives lastSync as max connection sync; prefers server-provided state', async () => {
    const { fetchRoster } = await import('./_lib/api');
    apiFetch.mockResolvedValueOnce(
      json({
        users: [
          {
            id: 'a',
            email: 'a@x',
            name: null,
            latestState: 'ambiguous',
            latestStateAsOf: '2026-10-02',
            connections: [
              {
                provider: 'oura',
                role: 'daily_metrics_source',
                lastSyncAt: '2026-10-01T00:00:00Z',
              },
              { provider: 'strava', role: 'activity_source', lastSyncAt: '2026-10-03T00:00:00Z' },
              { provider: 'terra', role: 'activity_source', lastSyncAt: null },
            ],
          },
        ],
      }),
    );
    const rows = await fetchRoster();
    expect(apiFetch).toHaveBeenCalledTimes(1); // no per-user trends call
    expect(rows[0]!.lastSyncAt).toBe('2026-10-03T00:00:00Z');
    expect(rows[0]!.latestState).toBe('ambiguous');
  });

  it('throws ApiError with status on 403 (non-master reaches API)', async () => {
    const { fetchRoster, ApiError } = await import('./_lib/api');
    apiFetch.mockResolvedValueOnce(json({}, 403));
    await expect(fetchRoster()).rejects.toBeInstanceOf(ApiError);
    apiFetch.mockResolvedValueOnce(json({}, 403));
    await expect(fetchRoster()).rejects.toMatchObject({ status: 403 });
  });
});

describe('comparison client', () => {
  it('passes range, unwraps lists, and PUTs promote with encoded id', async () => {
    const { fetchClassifiers, fetchDerivers, promoteClassifier } = await import('./_lib/api');
    apiFetch.mockResolvedValueOnce(json({ classifiers: [{ id: 'a' }] }));
    expect(await fetchClassifiers('30d')).toEqual([{ id: 'a' }]);
    expect(apiFetch).toHaveBeenLastCalledWith('/comparison/classifiers?range=30d');
    apiFetch.mockResolvedValueOnce(json({ derivers: [{ id: 'd' }] }));
    expect(await fetchDerivers()).toEqual([{ id: 'd' }]);
    apiFetch.mockResolvedValueOnce(json({}, 200));
    await promoteClassifier('a/b c');
    expect(apiFetch).toHaveBeenLastCalledWith('/comparison/classifiers/a%2Fb%20c/default', {
      method: 'PUT',
    });
    apiFetch.mockResolvedValueOnce(json({}, 400));
    await expect(promoteClassifier('x')).rejects.toMatchObject({ status: 400 });
  });
});

describe('makeDefaultAction (server-enforced)', () => {
  const fd = (id?: string) => {
    const f = new FormData();
    if (id !== undefined) f.set('classifierId', id);
    return f;
  };
  it('redirects non-master before calling the API', async () => {
    const { makeDefaultAction } = await import('./classifiers/actions');
    auth.mockResolvedValue({ user: { role: 'user' } });
    await expect(makeDefaultAction(fd('alt'))).rejects.toThrow('REDIRECT:/dashboard');
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it('redirects anonymous to /login', async () => {
    const { makeDefaultAction } = await import('./classifiers/actions');
    auth.mockResolvedValue(null);
    await expect(makeDefaultAction(fd('alt'))).rejects.toThrow('REDIRECT:/login');
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it('master: promotes and revalidates; rejects missing id', async () => {
    const { makeDefaultAction } = await import('./classifiers/actions');
    auth.mockResolvedValue({ user: { role: 'master' } });
    apiFetch.mockResolvedValue(json({}));
    await makeDefaultAction(fd('alt'));
    expect(revalidatePath).toHaveBeenCalledWith('/admin/classifiers');
    await expect(makeDefaultAction(fd())).rejects.toThrow();
    await expect(makeDefaultAction(fd(''))).rejects.toThrow();
  });
  it('does not revalidate when API refuses (403)', async () => {
    const { makeDefaultAction } = await import('./classifiers/actions');
    auth.mockResolvedValue({ user: { role: 'master' } });
    apiFetch.mockResolvedValue(json({}, 403));
    await expect(makeDefaultAction(fd('alt'))).rejects.toThrow();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('athlete drill-down page', () => {
  const classifiers = [
    { id: 'def', isDefault: true },
    { id: 'alt', isDefault: false },
  ];
  it('forwards known ?classifier and ignores unknown ids', async () => {
    const { default: Page } = await import('./athletes/[userId]/page');
    // Integration D: the page now resolves the viewer (for vote attribution in AthleteDashboard).
    auth.mockResolvedValue({ user: { id: 'm1', role: 'master' } });
    apiFetch.mockResolvedValue(json({ classifiers }));
    const el = await Page({
      params: Promise.resolve({ userId: 'u1' }),
      searchParams: Promise.resolve({ classifier: 'alt' }),
    });
    const kids = JSON.stringify(el.props.children, (_k, v) => (typeof v === 'function' ? 'fn' : v));
    expect(kids).toContain('"selected":"alt"');
    expect(kids).toContain('"userId":"u1"');
    const el2 = await Page({
      params: Promise.resolve({ userId: 'u1' }),
      searchParams: Promise.resolve({ classifier: "'; DROP" }),
    });
    const kids2 = JSON.stringify(el2.props.children);
    expect(kids2).toContain('"selected":null');
  });
});

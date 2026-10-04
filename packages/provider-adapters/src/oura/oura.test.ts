/// <reference types="node" />
import { describe, expect, it, vi } from 'vitest';
import bundle from './__fixtures__/bundle.json';
import {
  OuraAdapter,
  OuraAuthError,
  OuraHttpError,
  OuraRateLimitError,
  computeOuraRange,
} from './adapter';
import { type OuraConfig, ouraConfigFromEnv } from './config';
import { normalizeOura } from './mapping';

const NOW = new Date('2026-09-10T12:00:00Z');
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

function setup(
  over: Partial<OuraConfig> = {},
  handler?: (url: string, init?: RequestInit) => Response,
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler ? handler(String(url), init) : json({ data: [] });
  });
  const cfg: OuraConfig = {
    ...ouraConfigFromEnv({}),
    clientId: 'cid',
    clientSecret: 'secret',
    now: () => NOW,
    sleep: async () => {},
    fetch: fetchMock as unknown as typeof fetch,
    ...over,
  };
  return { adapter: new OuraAdapter(cfg), calls, cfg };
}

describe('normalize', () => {
  it('maps fixtures to the four metrics, preferring long_sleep, dropping nulls/bad dates', () => {
    const out = normalizeOura(bundle);
    const k = (d: string, m: string) => out.find((r) => r.date === d && r.metricType === m)?.value;
    expect(k('2026-09-01', 'readiness')).toBe(82);
    expect(k('2026-09-01', 'sleep_score')).toBe(77);
    expect(k('2026-09-01', 'hrv')).toBe(54);
    // PublicSleepType 'deleted' periods never produce metrics (2026-09-03 only has a deleted period)
    expect(out.some((r) => r.date === '2026-09-03')).toBe(false);
    expect(k('2026-09-01', 'resting_hr')).toBe(48);
    expect(k('2026-09-02', 'resting_hr')).toBe(50);
    expect(k('2026-09-02', 'hrv')).toBeUndefined();
    expect(k('2026-09-02', 'readiness')).toBeUndefined();
    expect(out).toHaveLength(5);
    expect(out.every((r) => r.source === 'oura')).toBe(true);
  });
  it('is tolerant of junk input', () => {
    expect(normalizeOura(null)).toEqual([]);
    expect(normalizeOura({ dailySleep: 'x', sleep: [1, null] })).toEqual([]);
  });
  it('is deterministic (idempotent input -> identical rows)', () => {
    expect(normalizeOura(bundle)).toEqual(normalizeOura(bundle));
  });
});

describe('computeOuraRange', () => {
  const cfg = { lookbackDays: 30, overlapDays: 2 };
  it('first sync looks back lookbackDays', () => {
    expect(computeOuraRange(null, NOW, cfg)).toEqual({
      startDate: '2026-08-11',
      endDate: '2026-09-11',
    });
  });
  it('incremental sync starts overlapDays before last_synced_at', () => {
    expect(computeOuraRange(new Date('2026-09-09T06:00:00Z'), NOW, cfg).startDate).toBe(
      '2026-09-07',
    );
  });
});

describe('start / callback', () => {
  it('builds the authorize URL with state passed through', async () => {
    const { adapter } = setup();
    const u = new URL((await adapter.start({ userId: 'u', state: 'st.ate' })).redirectUrl);
    expect(u.origin + u.pathname).toBe('https://cloud.ouraring.com/oauth/authorize');
    expect(u.searchParams.get('state')).toBe('st.ate');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('response_type')).toBe('code');
  });
  it('exchanges the code and returns an expiry', async () => {
    const { adapter, calls } = setup({}, (url) =>
      url.endsWith('/oauth/token')
        ? json({ access_token: 'A', refresh_token: 'R', expires_in: 3600, token_type: 'bearer' })
        : json({ id: 'oura-user-1' }),
    );
    const g = await adapter.handleCallback({ userId: 'u', query: { code: 'c', state: 's' } });
    expect(g).toMatchObject({ accessToken: 'A', refreshToken: 'R', externalUserId: 'oura-user-1' });
    expect(g.expiresAt?.toISOString()).toBe('2026-09-10T13:00:00.000Z');
    expect(String(calls[0]?.init?.body)).toContain('grant_type=authorization_code');
  });
  it('rejects denied/missing code', async () => {
    const { adapter } = setup();
    await expect(
      adapter.handleCallback({ userId: 'u', query: { error: 'access_denied' } }),
    ).rejects.toBeInstanceOf(OuraAuthError);
    await expect(adapter.handleCallback({ userId: 'u', query: {} })).rejects.toBeInstanceOf(
      OuraAuthError,
    );
  });
  it('sandbox mode needs no network or ring', async () => {
    const { adapter, calls } = setup({ sandbox: true });
    const { redirectUrl } = await adapter.start({ userId: 'u', state: 'x' });
    const q = Object.fromEntries(new URL(redirectUrl).searchParams);
    const g = await adapter.handleCallback({ userId: 'u', query: q });
    expect(g.accessToken).toBeTruthy();
    await adapter.fetchRaw({ userId: 'u', accessToken: g.accessToken, since: null });
    expect(calls.every((c) => c.url.includes('/v2/sandbox/usercollection/'))).toBe(true);
    await expect(
      adapter.handleCallback({ userId: 'u', query: { code: 'real' } }),
    ).rejects.toBeInstanceOf(OuraAuthError);
  });
});

describe('fetchRaw', () => {
  it('refreshes an expired token first, uses the new token, and returns the grant', async () => {
    const { adapter, calls } = setup({}, (url) =>
      url.endsWith('/oauth/token')
        ? json({ access_token: 'NEW', refresh_token: 'NEWR', expires_in: 100 })
        : json({ data: [] }),
    );
    const res = await adapter.fetchRaw({
      userId: 'u',
      accessToken: 'OLD',
      refreshToken: 'OLDR',
      expiresAt: new Date('2026-09-10T11:00:00Z'),
      since: null,
    });
    expect(res.refreshedGrant).toMatchObject({ accessToken: 'NEW', refreshToken: 'NEWR' });
    expect(String(calls[0]?.init?.body)).toContain('refresh_token=OLDR');
    const dataCalls = calls.filter((c) => c.url.includes('usercollection'));
    expect(dataCalls).toHaveLength(3);
    for (const c of dataCalls)
      expect((c.init?.headers as Record<string, string>).authorization).toBe('Bearer NEW');
  });
  it('does not refresh a valid token', async () => {
    const { adapter, calls } = setup();
    const res = await adapter.fetchRaw({
      userId: 'u',
      accessToken: 'OK',
      refreshToken: 'R',
      expiresAt: new Date('2026-09-11T00:00:00Z'),
      since: null,
    });
    expect(res.refreshedGrant).toBeUndefined();
    expect(calls.some((c) => c.url.endsWith('/oauth/token'))).toBe(false);
  });
  it('refreshes and retries once on a 401', async () => {
    let first = true;
    const { adapter } = setup({}, (url) => {
      if (url.endsWith('/oauth/token'))
        return json({ access_token: 'N', refresh_token: 'NR', expires_in: 10 });
      if (first) {
        first = false;
        return new Response('{}', { status: 401 });
      }
      return json({ data: [] });
    });
    const res = await adapter.fetchRaw({
      userId: 'u',
      accessToken: 'A',
      refreshToken: 'R',
      expiresAt: null,
      since: null,
    });
    expect(res.refreshedGrant?.accessToken).toBe('N');
  });
  it('attaches the refreshed grant to the error if the data fetch fails afterwards (single-use refresh token)', async () => {
    const { adapter } = setup({}, (url) =>
      url.endsWith('/oauth/token')
        ? json({ access_token: 'N', refresh_token: 'NR', expires_in: 10 })
        : new Response('x', { status: 500 }),
    );
    const err = await adapter
      .fetchRaw({
        userId: 'u',
        accessToken: 'A',
        refreshToken: 'R',
        expiresAt: new Date(0),
        since: null,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(OuraHttpError);
    expect(err.refreshedGrant.refreshToken).toBe('NR');
  });
  it('sends the incremental date range and follows next_token pagination', async () => {
    const { adapter, calls } = setup({}, (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith('daily_readiness') && !u.searchParams.get('next_token'))
        return json({ data: [{ day: '2026-09-08', score: 1 }], next_token: 'p2' });
      if (u.pathname.endsWith('daily_readiness'))
        return json({ data: [{ day: '2026-09-09', score: 2 }] });
      return json({ data: [] });
    });
    const res = await adapter.fetchRaw({
      userId: 'u',
      accessToken: 'A',
      expiresAt: null,
      since: new Date('2026-09-09T06:00:00Z'),
    });
    expect((res.raw as { dailyReadiness: unknown[] }).dailyReadiness).toHaveLength(2);
    const first = new URL(calls[0]!.url);
    expect(first.searchParams.get('start_date')).toBe('2026-09-07');
    expect(first.searchParams.get('end_date')).toBe('2026-09-11');
    expect(new URL(calls[1]!.url).searchParams.get('next_token')).toBe('p2');
  });
  it('waits out a short 429 then succeeds; fails fast on a long one', async () => {
    let n = 0;
    const sleep = vi.fn(async () => {});
    const a = setup({ sleep }, () =>
      n++ === 0
        ? new Response('', { status: 429, headers: { 'retry-after': '2' } })
        : json({ data: [] }),
    );
    await a.adapter.fetchRaw({ userId: 'u', accessToken: 'A', expiresAt: null, since: null });
    expect(sleep).toHaveBeenCalledWith(2000);
    const b = setup({}, () => new Response('', { status: 429, headers: { 'retry-after': '900' } }));
    await expect(
      b.adapter.fetchRaw({ userId: 'u', accessToken: 'A', expiresAt: null, since: null }),
    ).rejects.toBeInstanceOf(OuraRateLimitError);
  });
  it('errors never contain tokens', async () => {
    const { adapter } = setup({}, () => new Response('secret-body A-TOKEN', { status: 500 }));
    const err = await adapter
      .fetchRaw({ userId: 'u', accessToken: 'A-TOKEN', expiresAt: null, since: null })
      .catch((e) => e);
    expect(String(err.message)).not.toContain('TOKEN');
  });
});

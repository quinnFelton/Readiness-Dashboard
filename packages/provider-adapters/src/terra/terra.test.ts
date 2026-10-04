import { describe, expect, it, vi } from 'vitest';
import { createTerraAdapter } from './adapter';
import { TerraRateLimitError, createTerraClient } from './client';
import { normalizeTerraPayload } from './normalize';
import { REFERENCE_ID, TERRA_USER_ID, dailyPayload, sleepPayload } from './__fixtures__/sleep';

const pick = (rows: ReturnType<typeof normalizeTerraPayload>) =>
  rows.map((r) => `${r.date}|${r.metricType}|${r.value}`).sort();

describe('normalizeTerraPayload', () => {
  it('maps sleep sessions to hrv(rmssd)/resting_hr/sleep_score on the wake date', () => {
    expect(pick(normalizeTerraPayload(sleepPayload))).toEqual([
      '2026-03-02|hrv|64.2',
      '2026-03-02|resting_hr|51',
      '2026-03-02|sleep_score|82',
      '2026-03-03|sleep_score|77',
    ]);
  });

  it('stamps source terra', () => {
    expect(normalizeTerraPayload(sleepPayload).every((r) => r.source === 'terra')).toBe(true);
  });

  it('does not map daily/body payloads (avoids order-dependent collisions)', () => {
    expect(normalizeTerraPayload(dailyPayload)).toEqual([]);
    expect(normalizeTerraPayload({ type: 'body', data: [] })).toEqual([]);
  });

  it.each([
    null,
    undefined,
    'x',
    3,
    [],
    {},
    { type: 'sleep' },
    { type: 'sleep', data: [null, 1, {}] },
  ])('returns [] for malformed input %j', (bad) => {
    expect(normalizeTerraPayload(bad)).toEqual([]);
  });

  it('is deterministic (idempotent input -> identical output)', () => {
    expect(normalizeTerraPayload(sleepPayload)).toEqual(normalizeTerraPayload(sleepPayload));
  });
});

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

describe('terra client', () => {
  it('generates a widget session with reference_id and credentials headers', async () => {
    const f = vi.fn(async () =>
      json(
        { url: 'https://access.tryterra.co/widget/session/abc', session_id: 'abc' },
        { status: 201 },
      ),
    );
    const adapter = createTerraAdapter({
      devId: 'dev',
      apiKey: 'key',
      providers: 'ZEPP',
      successRedirectUrl: 'https://app.example/settings',
      fetch: f as unknown as typeof fetch,
    });
    const { redirectUrl } = await adapter.start({ userId: REFERENCE_ID, state: 'st.ate' });
    expect(redirectUrl).toBe('https://access.tryterra.co/widget/session/abc');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://access.tryterra.co/api/widget/session');
    expect(init.headers).toMatchObject({ 'dev-id': 'dev', 'x-api-key': 'key' });
    const body = JSON.parse(init.body as string);
    expect(body.reference_id).toBe(REFERENCE_ID);
    expect(body.providers).toBe('ZEPP');
    expect(body.auth_success_redirect_url).toContain('state=st.ate');
  });

  it('callback binds only when reference_id is the authenticated user', async () => {
    const adapter = createTerraAdapter({
      devId: 'd',
      apiKey: 'k',
      successRedirectUrl: 'https://app.example/s',
    });
    await expect(
      adapter.handleCallback({
        userId: REFERENCE_ID,
        query: { user_id: TERRA_USER_ID, reference_id: REFERENCE_ID },
      }),
    ).resolves.toEqual({ externalUserId: TERRA_USER_ID });
    await expect(
      adapter.handleCallback({
        userId: REFERENCE_ID,
        query: { user_id: TERRA_USER_ID, reference_id: 'other' },
      }),
    ).rejects.toThrow(/mismatch/);
    await expect(adapter.handleCallback({ userId: REFERENCE_ID, query: {} })).rejects.toThrow();
  });

  it('is push-only: no fetchRaw, so SyncService can never poll it', () => {
    const adapter = createTerraAdapter({
      devId: 'd',
      apiKey: 'k',
      successRedirectUrl: 'https://a/b',
    });
    expect(adapter.fetchRaw).toBeUndefined();
  });

  it('backfill requests sleep history delivered to the webhook and reads rate-limit headers', async () => {
    const f = vi.fn(async () =>
      json(
        { status: 'success' },
        {
          headers: {
            'x-terra-ratelimit-limit': '6000',
            'x-terra-ratelimit-remaining': '5910',
            'x-terra-ratelimit-reset-after': '1200',
          },
        },
      ),
    );
    const c = createTerraClient({ devId: 'd', apiKey: 'k', fetch: f as unknown as typeof fetch });
    const rl = await c.requestSleepBackfill({
      terraUserId: 'tu',
      startDate: '2026-01-01',
      endDate: '2026-04-01',
    });
    expect(rl).toEqual({ limit: 6000, remaining: 5910, resetAfterSec: 1200 });
    const [url] = f.mock.calls[0] as unknown as [string];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://api.tryterra.co/v2/sleep');
    expect(u.searchParams.get('to_webhook')).toBe('true');
    expect(u.searchParams.get('user_id')).toBe('tu');
  });

  it('surfaces 429 with Retry-After, without leaking the body', async () => {
    const f = vi.fn(
      async () =>
        new Response('secret health body', {
          status: 429,
          headers: { 'x-terra-ratelimit-rule': 'r2', 'retry-after': '120' },
        }),
    );
    const c = createTerraClient({ devId: 'd', apiKey: 'k', fetch: f as unknown as typeof fetch });
    const err = await c
      .requestSleepBackfill({ terraUserId: 'tu', startDate: '2026-01-01', endDate: '2026-02-01' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TerraRateLimitError);
    expect(err.rule).toBe('r2');
    expect(err.retryAfterSec).toBe(120);
    expect(String(err.message)).not.toContain('secret');
  });

  it('backs off before sending a request the known budget cannot afford', async () => {
    let t = 1_000_000;
    const f = vi.fn(async () =>
      json(
        {},
        {
          headers: { 'x-terra-ratelimit-remaining': '10', 'x-terra-ratelimit-reset-after': '600' },
        },
      ),
    );
    const c = createTerraClient({
      devId: 'd',
      apiKey: 'k',
      fetch: f as unknown as typeof fetch,
      now: () => t,
    });
    const req = { terraUserId: 'tu', startDate: '2026-01-01', endDate: '2026-02-01' }; // 31 days
    await c.requestSleepBackfill(req); // first call learns remaining=10
    await expect(c.requestSleepBackfill(req)).rejects.toBeInstanceOf(TerraRateLimitError);
    expect(f).toHaveBeenCalledTimes(1); // second never hit the network
    t += 601_000; // budget reset
    await c.requestSleepBackfill(req);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

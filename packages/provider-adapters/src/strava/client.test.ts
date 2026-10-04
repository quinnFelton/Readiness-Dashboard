import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, steadyStreams, tokenResponse } from './__fixtures__/strava';
import { StravaAuthError, StravaClient, tokenNeedsRefresh } from './client';
import { StravaRateLimitError, StravaRateLimiter } from './rate-limit';

const cfg = { clientId: '123', clientSecret: 'shh', redirectUri: 'http://localhost/cb' };
const now = () => new Date('2026-03-01T10:07:00Z');

describe('StravaClient OAuth', () => {
  it('builds the authorize URL with activity:read_all and state', () => {
    const url = new URL(new StravaClient(cfg).authorizeUrl('signed-state'));
    expect(url.origin + url.pathname).toBe('https://www.strava.com/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('activity:read_all');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('signed-state');
    expect(url.searchParams.get('client_id')).toBe('123');
  });

  it('refresh posts grant_type=refresh_token and maps the response (rotated refresh token)', async () => {
    const f = vi.fn(async () => jsonResponse(tokenResponse()));
    const grant = await new StravaClient({ ...cfg, fetch: f as never }).refresh('old-refresh');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://www.strava.com/oauth/token');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-refresh');
    expect(body.get('client_secret')).toBe('shh');
    expect(grant).toEqual({
      externalUserId: '4242',
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: new Date(1_900_000_000 * 1000),
    });
  });

  it('maps 400/401 from the token endpoint to StravaAuthError without echoing the body', async () => {
    const f = vi.fn(async () => jsonResponse({ message: 'Bad Request', secret: 'x' }, 400));
    const err = await new StravaClient({ ...cfg, fetch: f as never }).refresh('r').catch((e) => e);
    expect(err).toBeInstanceOf(StravaAuthError);
    expect(String(err.message)).not.toContain('secret');
  });
});

describe('tokenNeedsRefresh', () => {
  const n = now();
  it('is true when expired, unknown, or inside the skew', () => {
    expect(tokenNeedsRefresh(null, n)).toBe(true);
    expect(tokenNeedsRefresh(new Date(n.getTime() - 1), n)).toBe(true);
    expect(tokenNeedsRefresh(new Date(n.getTime() + 600_000), n, 900)).toBe(true);
  });
  it('is false with plenty of life left', () => {
    expect(tokenNeedsRefresh(new Date(n.getTime() + 3 * 3600_000), n, 900)).toBe(false);
  });
});

describe('StravaClient API calls', () => {
  it('requests only time,watts,heartrate keyed by type, with the bearer token', async () => {
    const f = vi.fn(async () => jsonResponse(steadyStreams(5)));
    const s = await new StravaClient({ ...cfg, fetch: f as never }).getStreams('tok', 9001);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.pathname).toBe('/api/v3/activities/9001/streams');
    expect(u.searchParams.get('keys')).toBe('time,watts,heartrate');
    expect(u.searchParams.get('key_by_type')).toBe('true');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(s?.watts?.data).toHaveLength(5);
  });

  it('returns null on 404', async () => {
    const f = vi.fn(async () => jsonResponse({}, 404));
    expect(await new StravaClient({ ...cfg, fetch: f as never }).getActivity('t', 1)).toBeNull();
  });

  it('feeds rate-limit headers into the limiter and refuses the next call near the ceiling', async () => {
    const limiter = new StravaRateLimiter({ now, maxWaitMs: 0 });
    const f = vi.fn(async () =>
      jsonResponse({ id: 1 }, 200, {
        'x-readratelimit-limit': '100,1000',
        'x-readratelimit-usage': '92,300',
      }),
    );
    const c = new StravaClient({ ...cfg, fetch: f as never, limiter, now });
    await c.getActivity('t', 1);
    await expect(c.getActivity('t', 2)).rejects.toBeInstanceOf(StravaRateLimitError);
    expect(f).toHaveBeenCalledTimes(1); // second call never left the process
  });

  it('turns a 429 into StravaRateLimitError and blocks further calls', async () => {
    const limiter = new StravaRateLimiter({ now, maxWaitMs: 0 });
    const f = vi.fn(async () => jsonResponse({}, 429));
    const c = new StravaClient({ ...cfg, fetch: f as never, limiter, now });
    const err = await c.getActivity('t', 1).catch((e) => e);
    expect(err).toBeInstanceOf(StravaRateLimitError);
    expect(err.retryAt).toEqual(new Date('2026-03-01T10:15:00Z'));
    await expect(c.getActivity('t', 1)).rejects.toBeInstanceOf(StravaRateLimitError);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

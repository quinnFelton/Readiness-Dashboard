import { describe, expect, it } from 'vitest';
import {
  StravaRateLimitError,
  StravaRateLimiter,
  nextFifteenMinuteBoundary,
  parsePair,
} from './rate-limit';

const headers = (usage: string, limit = '100,1000') =>
  new Headers({ 'x-readratelimit-usage': usage, 'x-readratelimit-limit': limit });

describe('parsePair', () => {
  it('parses "15min,daily"', () =>
    expect(parsePair('12, 340')).toEqual({ fifteen: 12, daily: 340 }));
  it('rejects malformed values', () => {
    expect(parsePair('12')).toBeNull();
    expect(parsePair('a,b')).toBeNull();
    expect(parsePair(null)).toBeNull();
  });
});

describe('StravaRateLimiter', () => {
  const t0 = new Date('2026-03-01T10:07:00Z'); // next quarter boundary 10:15:00

  it('does not wait while usage is below the ceiling', async () => {
    const slept: number[] = [];
    const l = new StravaRateLimiter({ now: () => t0, sleep: async (ms) => void slept.push(ms) });
    l.update(headers('89,500'));
    await l.beforeRequest();
    expect(slept).toEqual([]);
  });

  it('backs off to the next 15-minute boundary BEFORE hitting the limit', async () => {
    const slept: number[] = [];
    const l = new StravaRateLimiter({
      now: () => t0,
      sleep: async (ms) => void slept.push(ms),
      maxWaitMs: 10 * 60_000,
    });
    l.update(headers('90,500')); // 90% of 100 → ceiling, still 10 requests of headroom
    await l.beforeRequest();
    expect(slept).toEqual([nextFifteenMinuteBoundary(t0).getTime() - t0.getTime() + 1000]);
    await l.beforeRequest(); // usage cleared after the window rolled
    expect(slept).toHaveLength(1);
  });

  it('throws with retryAt instead of sleeping longer than maxWaitMs', async () => {
    const l = new StravaRateLimiter({ now: () => t0, maxWaitMs: 0 });
    l.update(headers('95,500'));
    await expect(l.beforeRequest()).rejects.toMatchObject({
      name: 'StravaRateLimitError',
      scope: '15min',
      retryAt: new Date('2026-03-01T10:15:00Z'),
    });
  });

  it('throws until UTC midnight when the daily budget is nearly used', async () => {
    const l = new StravaRateLimiter({ now: () => t0 });
    l.update(headers('5,950'));
    const err = await l.beforeRequest().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StravaRateLimitError);
    expect((err as StravaRateLimitError).scope).toBe('daily');
    expect((err as StravaRateLimitError).retryAt).toEqual(new Date('2026-03-02T00:00:00Z'));
  });

  it('ignores usage recorded in an earlier 15-minute window', async () => {
    let now = t0;
    const l = new StravaRateLimiter({ now: () => now, maxWaitMs: 0 });
    l.update(headers('99,100'));
    now = new Date('2026-03-01T10:16:00Z');
    await expect(l.beforeRequest()).resolves.toBeUndefined();
  });

  it('falls back to the overall headers when read headers are absent', async () => {
    const l = new StravaRateLimiter({ now: () => t0, maxWaitMs: 0 });
    l.update(new Headers({ 'x-ratelimit-usage': '190,500', 'x-ratelimit-limit': '200,2000' }));
    await expect(l.beforeRequest()).rejects.toBeInstanceOf(StravaRateLimitError);
  });
});

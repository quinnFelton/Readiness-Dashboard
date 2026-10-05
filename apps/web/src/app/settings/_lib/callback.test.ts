import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeOAuthCallback, signInRedirectFor } from './callback';

const CODE = 'SECRET-CODE-123';
const json = (status: number) => new Response('{}', { status });

afterEach(() => vi.restoreAllMocks());

describe('completeOAuthCallback', () => {
  it('forwards the exact query to the API (apiFetch attaches the Bearer token)', async () => {
    const api = vi.fn().mockResolvedValue(json(200));
    const out = await completeOAuthCallback(
      'strava',
      { code: CODE, state: 'a.b', scope: 'read,activity:read_all' },
      api,
    );
    expect(out).toEqual({ status: 'success' });
    expect(api).toHaveBeenCalledWith(
      `/connections/strava/callback?code=${CODE}&state=a.b&scope=read%2Cactivity%3Aread_all`,
    );
  });

  it('error=access_denied shows denied message without calling the API', async () => {
    const api = vi.fn();
    const out = await completeOAuthCallback('oura', { error: 'access_denied', state: 's' }, api);
    expect(out.status).toBe('denied');
    expect(api).not.toHaveBeenCalled();
  });

  it('API 400 (invalid state) yields a retryable error', async () => {
    const out = await completeOAuthCallback(
      'oura',
      { code: CODE, state: 'bad' },
      vi.fn().mockResolvedValue(json(400)),
    );
    expect(out).toMatchObject({ status: 'error' });
    expect((out as { message: string }).message).toMatch(/invalid or has expired/);
  });

  it('never writes the code to console or into messages', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const outcomes = [
      await completeOAuthCallback(
        'oura',
        { code: CODE, state: 's' },
        vi.fn().mockResolvedValue(json(400)),
      ),
      await completeOAuthCallback(
        'oura',
        { code: CODE, state: 's' },
        vi.fn().mockResolvedValue(json(500)),
      ),
      await completeOAuthCallback(
        'oura',
        { code: CODE, state: 's' },
        vi.fn().mockRejectedValue(new Error(CODE)),
      ),
    ];
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(CODE);
    expect(JSON.stringify(outcomes)).not.toContain(CODE);
  });

  it('rejects a missing code/state and bad provider names without calling the API', async () => {
    const api = vi.fn();
    expect((await completeOAuthCallback('oura', { state: 's' }, api)).status).toBe('error');
    expect((await completeOAuthCallback('../x', { code: 'c', state: 's' }, api)).status).toBe(
      'error',
    );
    expect(api).not.toHaveBeenCalled();
  });
});

describe('signInRedirectFor', () => {
  it('returns to the same callback URL, keeping the query', () => {
    const url = signInRedirectFor('oura', { code: 'c', state: 's' });
    const back = new URL(url, 'http://x').searchParams.get('callbackUrl');
    expect(back).toBe('/settings/connections/oura/callback?code=c&state=s');
  });
});

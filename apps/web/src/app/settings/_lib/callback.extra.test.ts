import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildQueryString, completeOAuthCallback, signInRedirectFor } from './callback';

const ok = () => new Response('{}', { status: 200 });

describe('callback edge cases (tester)', () => {
  it('does not treat unrelated keys like "xcode"/"mystate" as code/state', async () => {
    const api = vi.fn().mockResolvedValue(ok());
    const out = await completeOAuthCallback('oura', { xcode: 'a', mystate: 'b' }, api);
    expect(out.status).toBe('error');
    expect(api).not.toHaveBeenCalled();
  });
  it('non-denied provider error does not call API', async () => {
    const api = vi.fn();
    const out = await completeOAuthCallback(
      'oura',
      { error: 'server_error', code: 'c', state: 's' },
      api,
    );
    expect(out.status).toBe('error');
    expect(api).not.toHaveBeenCalled();
  });
  it('access_denied wins even when code is also present', async () => {
    const api = vi.fn();
    const out = await completeOAuthCallback(
      'strava',
      { error: 'access_denied', code: 'c', state: 's' },
      api,
    );
    expect(out.status).toBe('denied');
    expect(api).not.toHaveBeenCalled();
  });
  it('4xx/5xx statuses yield an error outcome', async () => {
    for (const s of [403, 404, 500, 503]) {
      const out = await completeOAuthCallback(
        'oura',
        { code: 'c', state: 's' },
        vi.fn().mockResolvedValue(new Response('', { status: s })),
      );
      expect(out.status).toBe('error');
    }
  });
  it('encodes special characters and drops undefined values', () => {
    expect(buildQueryString({ code: 'a b&c=d', state: 's', x: undefined })).toBe(
      'code=a+b%26c%3Dd&state=s',
    );
  });
  it('sign-in redirect preserves encoded query round-trip', () => {
    const url = signInRedirectFor('strava', { code: 'a b&c', state: 's.t' });
    const back = new URL(url, 'http://x').searchParams.get('callbackUrl');
    expect(back).toBe('/settings/connections/strava/callback?code=a+b%26c&state=s.t');
  });
  it('login page honors callbackUrl (spec: return to same URL after sign-in)', () => {
    const src = readFileSync(resolve(__dirname, '../../(auth)/login/page.tsx'), 'utf8');
    expect(src).toMatch(/callbackUrl/);
  });
});

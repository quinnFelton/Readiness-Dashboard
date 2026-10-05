// Integration stage D: the /settings/connections/<provider>/callback page (6c) forwards the provider's
// query to the mounted API route /api/v1/connections/<provider>/callback (apiFetch adds /api/v1;
// the API side of the round-trip is apps/api/src/connections/oauth-roundtrip.test.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const apiFetch = vi.fn();
vi.mock('@/lib/auth/api-fetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
const auth = vi.fn();
vi.mock('@/lib/auth', () => ({ auth: () => auth() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

import Page from './page';

const run = (provider: string, query: Record<string, string>) =>
  Page({ params: Promise.resolve({ provider }), searchParams: Promise.resolve(query) });

beforeEach(() => {
  apiFetch.mockReset();
  auth.mockResolvedValue({ user: { id: 'u1', role: 'user' } });
});

describe('OAuth callback page', () => {
  it.each(['oura', 'strava'])(
    '%s: calls /connections/<provider>/callback with code+state and redirects on success',
    async (provider) => {
      apiFetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await expect(run(provider, { code: 'abc', state: 's.t' })).rejects.toThrow(
        `REDIRECT:/settings/connections?connected=${provider}`,
      );
      expect(apiFetch).toHaveBeenCalledWith(`/connections/${provider}/callback?code=abc&state=s.t`);
    },
  );

  it('signed out: redirects to login keeping the callback URL, no API call', async () => {
    auth.mockResolvedValue(null);
    await expect(run('oura', { code: 'abc', state: 's' })).rejects.toThrow(
      `REDIRECT:/login?callbackUrl=${encodeURIComponent('/settings/connections/oura/callback?code=abc&state=s')}`,
    );
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('API 400 (bad state) renders the retryable error, not a redirect', async () => {
    apiFetch.mockResolvedValue(new Response('{}', { status: 400 }));
    const el = await run('oura', { code: 'abc', state: 'bad' });
    const text = JSON.stringify(el.props.children, (k, v) =>
      k === '_owner' || k === '_store' || k === 'type' || typeof v === 'function' ? undefined : v,
    );
    expect(text).toMatch(/invalid or has expired/);
    expect(text).toMatch(/Connection failed/);
  });
});

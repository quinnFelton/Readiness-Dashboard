import { describe, expect, it, vi } from 'vitest';
import { OuraAdapter } from './oura/adapter';
import { ouraConfigFromEnv } from './oura/config';
import { createStravaAdapter } from './strava/adapter';
import { StravaClient } from './strava/client';
import { createTerraAdapter } from './terra/adapter';

// Phase 9 (security review M1): revoke at the provider. All HTTP is a stub (CLAUDE.md rule 10).

const ok = () => new Response('', { status: 200 });

describe('Strava revoke', () => {
  const mk = (f: unknown) =>
    createStravaAdapter({
      client: new StravaClient({
        clientId: '123',
        clientSecret: 'shh',
        redirectUri: 'http://localhost/cb',
        fetch: f as typeof fetch,
      }),
    });

  it('POSTs the token to /oauth/revoke with HTTP Basic client credentials', async () => {
    const f = vi.fn(async () => ok());
    await mk(f).revoke!({ accessToken: 'acc', refreshToken: 'ref' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://www.strava.com/oauth/revoke');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('123:shh').toString('base64')}`,
    );
    expect(new URLSearchParams(init.body as string).get('token')).toBe('ref');
  });

  it('does nothing without a token; a failure carries the status only, never the token', async () => {
    const f = vi.fn(async () => new Response('tok-SECRET', { status: 500 }));
    await mk(f).revoke!({});
    expect(f).not.toHaveBeenCalled();
    const err = await mk(f).revoke!({ accessToken: 'tok-SECRET' }).catch((e: Error) => e);
    expect(String((err as Error).message)).toBe('strava http 500');
  });
});

describe('Oura revoke', () => {
  const adapter = (f: unknown, sandbox = false) =>
    new OuraAdapter({
      ...ouraConfigFromEnv({
        OURA_CLIENT_ID: 'id',
        OURA_CLIENT_SECRET: 'secret',
        OURA_REDIRECT_URI: 'http://localhost/cb',
        ...(sandbox ? { OURA_USE_SANDBOX: 'true' } : {}),
      } as NodeJS.ProcessEnv),
      fetch: f as typeof fetch,
    });

  it('GETs /oauth/revoke?access_token=…', async () => {
    const f = vi.fn(async () => ok());
    await adapter(f).revoke({ accessToken: 'acc' });
    const [url] = f.mock.calls[0] as unknown as [string];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://api.ouraring.com/oauth/revoke');
    expect(u.searchParams.get('access_token')).toBe('acc');
  });

  it('skips sandbox grants and tokenless connections; errors are status-only', async () => {
    const f = vi.fn(async () => new Response('', { status: 401 }));
    await adapter(f, true).revoke({ accessToken: 'sandbox' });
    await adapter(f).revoke({});
    expect(f).not.toHaveBeenCalled();
    const err = await adapter(f)
      .revoke({ accessToken: 'acc-SECRET' })
      .catch((e: Error) => e);
    expect((err as Error).message).toBe('oura http 401');
  });
});

describe('Terra deauthenticate', () => {
  it('calls /auth/deauthenticateUser with the terra user id and the dev-id / x-api-key headers', async () => {
    const f = vi.fn(async () => ok());
    const a = createTerraAdapter({
      devId: 'dev',
      apiKey: 'key',
      successRedirectUrl: 'http://localhost/ok',
      fetch: f as unknown as typeof fetch,
    });
    await a.revoke!({ externalUserId: 'tu-1' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://api.tryterra.co/v2/auth/deauthenticateUser');
    expect(u.searchParams.get('user_id')).toBe('tu-1');
    expect(init.headers).toMatchObject({ 'dev-id': 'dev', 'x-api-key': 'key' });
    await a.revoke!({});
    expect(f).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { verifyApiToken } from '../../../../api/src/auth/token';
import { authConfig } from './config';
import { mintApiToken } from './api-token';

const SECRET = 'web-test-secret-0123456789abcdef0123456789';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('mintApiToken (web) <-> verifyApiToken (api) contract', () => {
  it('a minted token verifies in the API with the same secret', () => {
    vi.stubEnv('NEXTAUTH_SECRET', SECRET);
    const t = mintApiToken({ id: '11111111-1111-4111-8111-111111111111', role: 'user' });
    const claims = verifyApiToken(t, { nowSec: Math.floor(Date.now() / 1000) });
    expect(claims?.sub).toBe('11111111-1111-4111-8111-111111111111');
    expect(claims?.role).toBe('user');
  });
  it('is rejected by the API after expiry', () => {
    vi.stubEnv('NEXTAUTH_SECRET', SECRET);
    const t = mintApiToken({ id: 'x', role: 'user' }, 60);
    expect(verifyApiToken(t, { nowSec: Math.floor(Date.now() / 1000) + 3600 })).toBeNull();
  });
  it('is rejected by the API when secrets differ', () => {
    vi.stubEnv('NEXTAUTH_SECRET', SECRET);
    const t = mintApiToken({ id: 'x', role: 'master' });
    vi.stubEnv('NEXTAUTH_SECRET', 'a-different-secret-0123456789abcdef012345');
    expect(verifyApiToken(t, { nowSec: Math.floor(Date.now() / 1000) })).toBeNull();
  });
  it('throws when NEXTAUTH_SECRET is unset', () => {
    vi.stubEnv('NEXTAUTH_SECRET', '');
    expect(() => mintApiToken({ id: 'x', role: 'user' })).toThrow();
  });
});

describe('NextAuth config callbacks', () => {
  it('uses the JWT session strategy (approved deviation)', () => {
    expect(authConfig.session.strategy).toBe('jwt');
  });
  it('jwt callback copies uid + role on sign-in and preserves them afterwards', () => {
    const jwt = authConfig.callbacks.jwt as unknown as (a: {
      token: Record<string, unknown>;
      user?: unknown;
    }) => Record<string, unknown>;
    const first = jwt({ token: {}, user: { id: 'u1', role: 'master' } });
    expect(first).toMatchObject({ uid: 'u1', role: 'master' });
    expect(jwt({ token: first })).toMatchObject({ uid: 'u1', role: 'master' });
  });
  it('session callback defaults a missing role to the least-privileged "user"', () => {
    const session = authConfig.callbacks.session as unknown as (a: {
      session: { user: Record<string, unknown> };
      token: Record<string, unknown>;
    }) => { user: Record<string, unknown> };
    expect(session({ session: { user: {} }, token: { uid: 'u1' } }).user).toMatchObject({
      id: 'u1',
      role: 'user',
    });
  });
});

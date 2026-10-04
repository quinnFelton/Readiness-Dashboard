import { describe, expect, it, vi } from 'vitest';

// Mock next-auth so `auth(handler)` returns the handler itself; we then drive it directly.
vi.mock('next-auth', () => ({
  default: () => ({ auth: (h: unknown) => h }),
}));

import middleware, { config } from '../../../middleware';

type Req = { auth: unknown; nextUrl: URL };
const run = (auth: unknown) =>
  (middleware as unknown as (r: Req) => Response)({
    auth,
    nextUrl: new URL('http://localhost:3000/admin/users'),
  });

describe('apps/web/middleware.ts wiring', () => {
  it('matcher covers /admin and subpaths only', () => {
    expect(config.matcher).toEqual(['/admin/:path*']);
  });
  it('redirects anonymous to /login', () => {
    const res = run(null);
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/login');
  });
  it('redirects a user-role session to /dashboard', () => {
    const res = run({ user: { role: 'user' } });
    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/dashboard');
  });
  it('lets master through', () => {
    const res = run({ user: { role: 'master' } });
    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBe(200);
  });
});

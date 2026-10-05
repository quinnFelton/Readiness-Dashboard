import { createHmac } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { API_URL, NEXTAUTH_SECRET } from './env';

// Direct API access for RBAC assertions that must not go through the web app. Mirrors what
// apps/web/src/lib/auth/api-token.ts mints (HS256, iss rd-web, aud rd-api); the API re-reads the
// role from Postgres on every request, so the `role` claim here grants nothing by itself.
export function mintApiToken(user: { id: string; role: 'user' | 'master' }, ttlSec = 300): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const data = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({
    sub: user.id,
    role: user.role,
    iss: 'rd-web',
    aud: 'rd-api',
    iat: now,
    exp: now + ttlSec,
  })}`;
  return `${data}.${createHmac('sha256', NEXTAUTH_SECRET).update(data).digest('base64url')}`;
}

export interface ApiUser {
  id: string;
  email: string;
  name: string | null;
  role: 'user' | 'master';
}

/** Looks up seeded accounts via GET /users as the master (the only role allowed to list them). */
export async function listUsers(request: APIRequestContext): Promise<ApiUser[]> {
  // The master's id is needed to mint its token; the API reads the role from the DB, so any
  // existing id works as `sub` for the lookup, but we need a real master: find it via /users/me
  // is circular, so bootstrap from the DB-independent route: the login endpoint.
  const login = await request.post(`${API_URL}/api/v1/auth/login`, {
    data: {
      email: 'master@example.test',
      password: process.env.AUTH_DEV_PASSWORD ?? 'e2e-password',
    },
  });
  const { user: master } = (await login.json()) as { user: ApiUser };
  const res = await request.get(`${API_URL}/api/v1/users`, {
    headers: { authorization: `Bearer ${mintApiToken(master)}` },
  });
  return ((await res.json()) as { users: ApiUser[] }).users;
}

export async function userByEmail(request: APIRequestContext, email: string): Promise<ApiUser> {
  const u = (await listUsers(request)).find((x) => x.email === email);
  if (!u) throw new Error(`no seeded user ${email}`);
  return u;
}

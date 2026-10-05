import { createHmac } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
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

let cachedUsers: Promise<ApiUser[]> | undefined;

/**
 * Looks up seeded accounts via GET /users as the master (the only role allowed to list them).
 * The master's id comes from the dev login route, which is throttled per client (10 attempts, then
 * one every 2 s), so the list is fetched once per worker and a throttled login is retried.
 */
export function listUsers(request: APIRequestContext): Promise<ApiUser[]> {
  cachedUsers ??= fetchUsers(request).catch((err: unknown) => {
    cachedUsers = undefined;
    throw err;
  });
  return cachedUsers;
}

async function fetchUsers(request: APIRequestContext): Promise<ApiUser[]> {
  let master: ApiUser | undefined;
  await expect(async () => {
    const login = await request.post(`${API_URL}/api/v1/auth/login`, {
      data: {
        email: 'master@example.test',
        password: process.env.AUTH_DEV_PASSWORD ?? 'e2e-password',
      },
    });
    expect(login.status(), 'dev login as the seeded master').toBe(200);
    master = ((await login.json()) as { user: ApiUser }).user;
  }).toPass({ timeout: 30_000 });
  const res = await request.get(`${API_URL}/api/v1/users`, {
    headers: { authorization: `Bearer ${mintApiToken(master!)}` },
  });
  expect(res.status(), 'GET /users as master').toBe(200);
  return ((await res.json()) as { users: ApiUser[] }).users;
}

export async function userByEmail(request: APIRequestContext, email: string): Promise<ApiUser> {
  const u = (await listUsers(request)).find((x) => x.email === email);
  if (!u) throw new Error(`no seeded user ${email}`);
  return u;
}

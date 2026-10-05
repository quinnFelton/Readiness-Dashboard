import { expect, test } from '@playwright/test';
import { API_URL, authFile, USERS } from './support/env';
import { mintApiToken, userByEmail } from './support/api';

// PLAN §10 flow 7 (negative): a regular user is blocked from /admin. Asserts the HTTP outcome
// (redirect / 403), not merely that a nav link is missing. Runs against the built app, where the
// Next 16 middleware/proxy file is what actually executes.
const ADMIN_PATHS = ['/admin', '/admin/classifiers'];

test.describe('regular user', () => {
  test.use({ storageState: authFile(USERS.viewer) });

  for (const path of ADMIN_PATHS) {
    test(`GET ${path} is redirected away with a 3xx`, async ({ request }) => {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status()).toBeGreaterThanOrEqual(300);
      expect(res.status()).toBeLessThan(400);
      expect(new URL(res.headers()['location']!, 'http://x').pathname).toBe('/dashboard');
    });

    test(`browsing to ${path} lands on the dashboard, not the admin page`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/dashboard$/);
      await expect(page.getByRole('heading', { name: 'Athletes' })).toHaveCount(0);
    });
  }

  test('an athlete drill-down URL is not reachable either', async ({ request }) => {
    const other = await userByEmail(request, USERS.disconnecter);
    const res = await request.get(`/admin/athletes/${other.id}`, { maxRedirects: 0 });
    expect(res.status()).toBeGreaterThanOrEqual(300);
    expect(res.status()).toBeLessThan(400);
    expect(new URL(res.headers()['location']!, 'http://x').pathname).toBe('/dashboard');
  });

  test('the API itself answers 403 to master-only routes (UI hiding is not the control)', async ({
    request,
  }) => {
    const me = await userByEmail(request, USERS.viewer);
    const headers = { authorization: `Bearer ${mintApiToken({ id: me.id, role: 'user' })}` };

    expect((await request.get(`${API_URL}/api/v1/users`, { headers })).status()).toBe(403);
    expect(
      (await request.get(`${API_URL}/api/v1/comparison/classifiers`, { headers })).status(),
    ).toBe(403);
  });

  test('the API refuses to serve another athlete’s trends (403) but serves their own', async ({
    request,
  }) => {
    const me = await userByEmail(request, USERS.viewer);
    const other = await userByEmail(request, USERS.disconnecter);
    const headers = { authorization: `Bearer ${mintApiToken({ id: me.id, role: 'user' })}` };

    expect((await request.get(`${API_URL}/api/v1/trends/${other.id}`, { headers })).status()).toBe(
      403,
    );
    expect((await request.get(`${API_URL}/api/v1/trends/${me.id}`, { headers })).status()).toBe(
      200,
    );
  });

  test('a forged "master" claim does not elevate a regular user', async ({ request }) => {
    const me = await userByEmail(request, USERS.viewer);
    // Claims say master; the API re-reads the role from Postgres.
    const headers = { authorization: `Bearer ${mintApiToken({ id: me.id, role: 'master' })}` };
    expect((await request.get(`${API_URL}/api/v1/users`, { headers })).status()).toBe(403);
  });
});

test.describe('signed-out visitor', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('GET /admin redirects to /login', async ({ request }) => {
    const res = await request.get('/admin', { maxRedirects: 0 });
    expect(res.status()).toBeGreaterThanOrEqual(300);
    expect(res.status()).toBeLessThan(400);
    expect(new URL(res.headers()['location']!, 'http://x').pathname).toBe('/login');
  });

  test('the API answers 401 without a token', async ({ request }) => {
    expect((await request.get(`${API_URL}/api/v1/users`)).status()).toBe(401);
    expect(
      (await request.get(`${API_URL}/api/v1/trends/00000000-0000-0000-0000-000000000000`)).status(),
    ).toBe(401);
  });
});

test.describe('master', () => {
  test.use({ storageState: authFile(USERS.master) });

  test('is let through to /admin (the guard is not simply denying everyone)', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { name: 'Athletes' })).toBeVisible();
  });
});

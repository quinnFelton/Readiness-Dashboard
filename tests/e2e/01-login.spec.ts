import { expect, test, type Page } from '@playwright/test';
import { AUTH_DEV_PASSWORD, USERS } from './support/env';

// PLAN §10 flow 1: login (valid / invalid credentials). These start signed out on purpose.
test.describe('login', () => {
  test('valid credentials land on the dashboard', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('Email').fill(USERS.empty);
    await page.getByPlaceholder('Password').fill(AUTH_DEV_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Readiness' })).toBeVisible();
    // A signed-in session exists, not just a page that happens to render.
    const session = await page.request.get('/api/auth/session');
    expect(((await session.json()) as { user?: { email?: string } }).user?.email).toBe(USERS.empty);
  });

  const submit = async (page: Page, email: string, password: string) => {
    await page.goto('/login');
    await page.getByPlaceholder('Email').fill(email);
    await page.getByPlaceholder('Password').fill(password);
    // Wait for the login server action to answer instead of racing it.
    const answered = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/login',
    );
    await page.getByRole('button', { name: 'Sign in' }).click();
    await answered;
  };

  test('wrong password creates no session', async ({ page }) => {
    await submit(page, USERS.empty, 'not-the-password');
    await expect(page).not.toHaveURL(/\/dashboard/);
    expect(await (await page.request.get('/api/auth/session')).json()).toBeNull();
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('unknown email creates no session', async ({ page }) => {
    await submit(page, 'nobody@example.test', AUTH_DEV_PASSWORD);
    await expect(page).not.toHaveURL(/\/dashboard/);
    expect(await (await page.request.get('/api/auth/session')).json()).toBeNull();
  });

  test('wrong password shows a sign-in error on the login page', async ({ page }) => {
    // Product bug, see docs/reports/7-test-report.md (#3): login/page.tsx does not catch NextAuth's
    // CredentialsSignin, so bad credentials render Next's "This page couldn't load" server-error
    // page instead of the login form with a message.
    test.fail();
    await submit(page, USERS.empty, 'not-the-password');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(
      page.getByRole('alert').filter({ hasText: /invalid|incorrect|wrong/i }),
    ).toBeVisible();
  });

  test('a signed-out visitor to /dashboard is sent to the login page', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });
});

import { expect, test } from '@playwright/test';
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

  test('wrong password is rejected and no session is created', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('Email').fill(USERS.empty);
    await page.getByPlaceholder('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).not.toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    const session = await page.request.get('/api/auth/session');
    expect(await session.json()).toBeNull();
  });

  test('unknown email is rejected', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('Email').fill('nobody@example.test');
    await page.getByPlaceholder('Password').fill(AUTH_DEV_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).not.toHaveURL(/\/dashboard/);
    expect(await (await page.request.get('/api/auth/session')).json()).toBeNull();
  });

  test('a signed-out visitor to /dashboard is sent to the login page', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });
});

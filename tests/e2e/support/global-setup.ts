import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium, type FullConfig } from '@playwright/test';
import { ALL_LOGIN_USERS, AUTH_DEV_PASSWORD, WEB_URL, apiEnv, authFile } from './env';

// Runs after the webServers are up. Migrates + seeds the database at DATABASE_URL, then signs each
// seeded account in once through the real login form and stores the session (storageState), so
// specs start authenticated without repeating the form. Flow 1 exercises the form itself.
export default async function globalSetup(_config: FullConfig): Promise<void> {
  const env = { ...process.env, ...apiEnv() };
  const run = (...args: string[]) =>
    execFileSync('pnpm', ['--filter', '@rd/api', ...args], { env, stdio: 'inherit' });

  // node-pg-migrate reads DATABASE_URL; the script's --envPath tolerates a missing .env.
  run('db:migrate');
  run('exec', 'tsx', '../../tests/e2e/support/seed-data.ts');

  mkdirSync('test-results/.auth', { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const email of ALL_LOGIN_USERS) {
      const ctx = await browser.newContext({ baseURL: WEB_URL });
      const page = await ctx.newPage();
      await page.goto('/login');
      await page.getByPlaceholder('Email').fill(email);
      await page.getByPlaceholder('Password').fill(AUTH_DEV_PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL('**/dashboard');
      await ctx.storageState({ path: authFile(email) });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

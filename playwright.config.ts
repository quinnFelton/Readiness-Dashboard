import { defineConfig, devices } from '@playwright/test';
import { API_URL, WEB_PORT, WEB_URL, apiEnv, webEnv } from './tests/e2e/support/env';

// PLAN §10. Two servers: the API (through a launcher that stubs Oura/Strava/Terra HTTP, see
// tests/e2e/support/api-server.ts) and the web app. CI and default local runs use a production build
// (`next build` + `next start`) so middleware/proxy and server components behave as deployed; set
// E2E_WEB_DEV=1 for the faster dev server. globalSetup migrates and seeds DATABASE_URL.
const useDevServer = process.env.E2E_WEB_DEV === '1';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  // Artifacts live in a subfolder so the saved sessions in test-results/.auth survive Playwright's
  // output-dir cleanup (test-results is git-, eslint- and prettier-ignored).
  outputDir: 'test-results/artifacts',
  globalSetup: './tests/e2e/support/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: WEB_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      name: 'api',
      command: 'pnpm --filter @rd/api exec tsx ../../tests/e2e/support/api-server.ts',
      url: `${API_URL}/api/v1/health`,
      env: apiEnv(),
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      name: 'web',
      command: useDevServer
        ? `pnpm --filter @rd/web exec next dev --port ${WEB_PORT}`
        : `pnpm --filter @rd/web build && pnpm --filter @rd/web exec next start --port ${WEB_PORT}`,
      url: `${WEB_URL}/login`,
      env: webEnv(),
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});

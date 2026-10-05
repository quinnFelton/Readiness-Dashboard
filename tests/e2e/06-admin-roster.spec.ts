import { expect, test } from '@playwright/test';
import { authFile, USERS } from './support/env';

// PLAN §10 flow 6: a master sees the full roster and can drill into one athlete's dashboard.
test.use({ storageState: authFile(USERS.master) });

test.describe('admin roster (master)', () => {
  test('lists every seeded athlete', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByRole('heading', { level: 1, name: 'Athletes' })).toBeVisible();

    const table = page.getByRole('table');
    await expect(table.getByRole('columnheader', { name: /Athlete/ })).toBeVisible();
    // user01..user10 + the master itself (apps/api/db/seed/accounts.ts).
    for (let n = 1; n <= 10; n++) {
      const name = `Test User ${String(n).padStart(2, '0')}`;
      await expect(table.getByRole('link', { name, exact: true })).toBeVisible();
    }
    await expect(table.getByRole('link', { name: 'Test Master', exact: true })).toBeVisible();
  });

  test('shows each athlete’s latest state', async ({ page }) => {
    await page.goto('/admin');
    const seeded = page.getByRole('row').filter({ hasText: USERS.viewer });
    await expect(seeded.getByText('Fitness gain')).toBeVisible();

    const empty = page.getByRole('row').filter({ hasText: USERS.empty });
    await expect(empty.getByText('No data yet')).toBeVisible();
    await expect(empty.getByText('None connected')).toBeVisible();
  });

  test('shows each athlete’s connected sources and last sync', async ({ page }) => {
    // Fixed (report bug #2): GET /users now returns connections and lastSyncAt.
    await page.goto('/admin');
    const seeded = page.getByRole('row').filter({ hasText: USERS.viewer });
    await expect(seeded).toContainText('oura');
    await expect(seeded).toContainText('strava');
    await expect(seeded).not.toContainText('Never');
  });

  test('drills into an individual athlete’s dashboard', async ({ page }) => {
    await page.goto('/admin');
    await page.getByRole('link', { name: 'Test User 01', exact: true }).click();

    await expect(page).toHaveURL(/\/admin\/athletes\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Athlete' })).toBeVisible();
    // The same dashboard as the athlete sees: state, chart, readiness.
    await expect(
      page
        .getByRole('region', { name: 'Current state' })
        .getByText('Fitness gain', { exact: true }),
    ).toBeVisible();
    const chart = page.getByRole('figure', { name: /EF peak-20 against HRV and resting HR/ });
    await expect(chart).toBeVisible();
    await expect(chart.locator('svg circle').first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Readiness score' })).toBeVisible();
  });

  test('drilling into an athlete with no data shows that athlete’s empty state', async ({
    page,
  }) => {
    await page.goto('/admin');
    await page.getByRole('link', { name: 'Test User 06', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'No data yet' })).toBeVisible();
    await expect(
      page.getByText('This athlete has not connected any data sources yet.'),
    ).toBeVisible();
  });
});

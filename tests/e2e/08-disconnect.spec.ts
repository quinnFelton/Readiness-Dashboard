import { expect, test, type Page } from '@playwright/test';
import { clickUntil, openConnections, providerCard } from './support/connections';
import { authFile, USERS } from './support/env';

// PLAN §10 flow 8: disconnecting a provider removes its data from subsequent dashboard renders.
// The user (user02) is seeded with Oura (HRV / resting HR / sleep) and Strava (rides), classifier
// history and readiness scores, and is mutated only here, so the file runs serially.
test.use({ storageState: authFile(USERS.disconnecter) });
test.describe.configure({ mode: 'serial' });

const heroChart = (page: Page) =>
  page.getByRole('figure', { name: /EF peak-20 against HRV and resting HR/ });

test.describe('disconnect Oura', () => {
  test('before: the dashboard shows Oura-derived data', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(heroChart(page)).toBeVisible();
    await expect(heroChart(page).getByText('HRV', { exact: true })).toBeVisible();
    await expect(heroChart(page).getByText('Resting HR', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Readiness score' })).toBeVisible();
  });

  test('cancelling the confirmation keeps the connection', async ({ page }) => {
    await openConnections(page);
    const card = providerCard(page, 'Oura');
    await expect(card).toContainText('Connected');
    const dialog = page.getByRole('alertdialog', { name: 'Disconnect Oura' });
    await clickUntil(card.getByRole('button', { name: 'Disconnect' }), () =>
      expect(dialog).toBeVisible({ timeout: 2_000 }),
    );
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(card).toContainText('Connected');
  });

  test('confirming removes the connection', async ({ page }) => {
    await openConnections(page);
    const card = providerCard(page, 'Oura');
    const dialog = page.getByRole('alertdialog', { name: 'Disconnect Oura' });
    await clickUntil(card.getByRole('button', { name: 'Disconnect' }), () =>
      expect(dialog).toBeVisible({ timeout: 2_000 }),
    );
    const done = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().includes('/settings/connections'),
    );
    await dialog.getByRole('button', { name: 'Disconnect and delete data' }).click();
    await done;

    await expect(card).toContainText('Not connected');
    await expect(card.getByRole('button', { name: 'Connect' })).toBeVisible();
    // Strava is untouched.
    await expect(providerCard(page, 'Strava')).toContainText('Connected');
    await page.reload();
    await expect(providerCard(page, 'Oura')).toContainText('Not connected');
  });

  test('after: the Oura series are gone from the dashboard chart', async ({ page }) => {
    await page.goto('/dashboard');
    const chart = heroChart(page);
    await expect(chart).toBeVisible();
    // The legend always lists the three series, so look at the plotted data instead: hover the
    // plot and read the tooltip. Strava's EF points are still there; Oura's HRV / resting HR are not.
    const box = await chart.locator('svg').first().boundingBox();
    await page.mouse.move(box!.x + box!.width - 60, box!.y + box!.height / 2);
    await expect(chart.getByText(/^EF peak-20: \d+\.\d{2} W\/bpm$/)).toBeVisible();
    await expect(chart.getByText(/^HRV: /)).toHaveCount(0);
    await expect(chart.getByText(/^Resting HR: /)).toHaveCount(0);
  });

  test('after: the readiness score derived from Oura is gone from the dashboard', async ({
    page,
  }) => {
    // Product bug, see docs/reports/7-test-report.md (#1): ConnectionService.disconnect deletes
    // daily_metrics / activity_efforts but leaves readiness_scores and trends, and nothing
    // recomputes them (no ingest path calls FatigueFitnessService.onSyncComplete), so the dashboard
    // keeps rendering a readiness score and fatigue/fitness state built from the deleted data.
    test.fail();
    await page.goto('/dashboard');
    await expect(page.getByRole('region', { name: 'Current state' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Readiness score' })).toHaveCount(0);
  });
});

import { expect, test } from '@playwright/test';
import { authFile, USERS } from './support/env';

// PLAN §10 flow 5: the dashboard renders a readiness score and the trend chart for a seeded user.
// Data comes from tests/e2e/support/seed-data.ts (28 days of Oura-style daily metrics, a ride every
// other day, classifier + readiness rows produced by FatigueFitnessService).
test.use({ storageState: authFile(USERS.viewer) });

test.describe('dashboard (seeded user)', () => {
  test('shows the current fatigue/fitness state', async ({ page }) => {
    await page.goto('/dashboard');

    const hero = page.getByRole('region', { name: 'Current state' });
    await expect(hero).toBeVisible();
    // Seed story: efficiency, HRV up and resting HR down over the last week.
    await expect(hero.getByText('Fitness gain', { exact: true })).toBeVisible();
    await expect(hero.getByText(/as of \d{4}-\d{2}-\d{2}/)).toBeVisible();
    // Not the empty/error states.
    await expect(page.getByRole('heading', { name: 'No data yet' })).toHaveCount(0);
    // (Next's empty route announcer is also role=alert, so match the error panel by its text.)
    await expect(page.getByRole('alert').filter({ hasText: 'Something went wrong' })).toHaveCount(
      0,
    );
  });

  test('shows a readiness score', async ({ page }) => {
    await page.goto('/dashboard');

    const card = page.getByRole('region', { name: 'Readiness score' });
    await expect(card).toBeVisible();
    const score = Number(await card.locator('span').first().innerText());
    expect(Number.isInteger(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  test('the hero chart actually renders data points, not just its container', async ({ page }) => {
    await page.goto('/dashboard');

    const chart = page.getByRole('figure', { name: /EF peak-20 against HRV and resting HR/ });
    await expect(chart).toBeVisible();
    for (const label of ['EF peak-20', 'HRV', 'Resting HR']) {
      await expect(chart.getByText(label, { exact: true })).toBeVisible();
    }

    // Recharts draws one <circle> per EF point (the sparse series shows dots). The seed has a ride
    // every other day for 28 days = 14 rides. A blank chart or a container-only render has none.
    const dots = chart.locator('svg circle');
    await expect(dots.first()).toBeVisible();
    expect(await dots.count()).toBeGreaterThanOrEqual(14);

    // And the lines carry real geometry: hovering the plot yields a tooltip with seeded values.
    const plot = chart.locator('svg').first();
    const box = await plot.boundingBox();
    expect(box?.width).toBeGreaterThan(200);
    expect(box?.height).toBeGreaterThan(100);
    await page.mouse.move(box!.x + box!.width - 60, box!.y + box!.height / 2);
    const hrvTip = chart.getByText(/^HRV: \d+\.\d{2} ms$/);
    await expect(hrvTip).toBeVisible();
    await expect(chart.getByText(/^Resting HR: \d+\.\d{2} bpm$/)).toBeVisible();
    const hrv = Number(/HRV: (\d+\.\d{2}) ms/.exec(await hrvTip.innerText())?.[1]);
    // Seeded recent-week HRV is 68 ± 2.
    expect(hrv).toBeGreaterThanOrEqual(66);
    expect(hrv).toBeLessThanOrEqual(70);
  });

  test('a user with no data sees the empty state pointing at connections', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: authFile(USERS.empty) });
    const page = await ctx.newPage();
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'No data yet' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Connect your data sources' })).toHaveAttribute(
      'href',
      '/settings/connections',
    );
    await ctx.close();
  });
});

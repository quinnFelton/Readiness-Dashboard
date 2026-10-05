import { expect, test, type Page } from '@playwright/test';
import { clickUntil, openConnections, providerCard } from './support/connections';
import { authFile, USERS } from './support/env';

// PLAN §10 flow 8: disconnecting a provider keeps the user's history by default, and removes that
// provider's data from subsequent dashboard renders only when the user asks for the erase.
// The user (user02) is seeded with Oura (HRV / resting HR / sleep) and Strava (rides), classifier
// history and readiness scores, and is mutated only here, so the file runs serially.
test.use({ storageState: authFile(USERS.disconnecter) });
test.describe.configure({ mode: 'serial' });

const heroChart = (page: Page) =>
  page.getByRole('figure', { name: /EF peak-20 against HRV and resting HR/ });

// The legend always lists the three series, so read the plotted data instead: hover the plot and
// look at the tooltip.
async function hoverChart(page: Page) {
  await page.goto('/dashboard');
  const chart = heroChart(page);
  await expect(chart).toBeVisible();
  const box = await chart.locator('svg').first().boundingBox();
  await page.mouse.move(box!.x + box!.width - 60, box!.y + box!.height / 2);
  return chart;
}

async function openDisconnectDialog(page: Page, name: string) {
  await openConnections(page);
  const card = providerCard(page, name);
  await expect(card).toContainText('Connected');
  const dialog = page.getByRole('alertdialog', { name: `Disconnect ${name}` });
  await clickUntil(card.getByRole('button', { name: 'Disconnect' }), () =>
    expect(dialog).toBeVisible({ timeout: 2_000 }),
  );
  return { card, dialog };
}

const disconnectResponse = (page: Page) =>
  page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/settings/connections'),
  );

test.describe('disconnect Strava, keeping the history', () => {
  test('before: the dashboard shows data from both providers', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(heroChart(page)).toBeVisible();
    await expect(heroChart(page).getByText('HRV', { exact: true })).toBeVisible();
    await expect(heroChart(page).getByText('Resting HR', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Readiness score' })).toBeVisible();
  });

  test('cancelling the confirmation keeps the connection', async ({ page }) => {
    const { card, dialog } = await openDisconnectDialog(page, 'Strava');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(card).toContainText('Connected');
  });

  test('confirming removes the connection and says the history stays', async ({ page }) => {
    const { card, dialog } = await openDisconnectDialog(page, 'Strava');
    await expect(dialog).toContainText('Your history stays');
    const done = disconnectResponse(page);
    await dialog.getByRole('button', { name: 'Disconnect and keep data' }).click();
    await done;

    await expect(card).toContainText('Not connected');
    await expect(card.getByRole('button', { name: 'Connect' })).toBeVisible();
    // Oura is untouched.
    await expect(providerCard(page, 'Oura')).toContainText('Connected');
    await page.reload();
    await expect(providerCard(page, 'Strava')).toContainText('Not connected');
  });

  test('after: the Strava rides, the state and the readiness score are still on the dashboard', async ({
    page,
  }) => {
    const chart = await hoverChart(page);
    await expect(chart.getByText(/^EF peak-20: \d+\.\d{2} W\/bpm$/)).toBeVisible();
    await expect(chart.getByText(/^HRV: /)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Current state' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Readiness score' })).toBeVisible();
  });
});

test.describe('disconnect Oura and delete its data', () => {
  test('confirming with the erase box ticked removes the connection', async ({ page }) => {
    const { card, dialog } = await openDisconnectDialog(page, 'Oura');
    await dialog.getByRole('checkbox', { name: /Also delete the data already synced/ }).check();
    await expect(dialog).toContainText('This cannot be undone');
    const done = disconnectResponse(page);
    await dialog.getByRole('button', { name: 'Disconnect and delete data' }).click();
    await done;

    await expect(card).toContainText('Not connected');
    await page.reload();
    await expect(providerCard(page, 'Oura')).toContainText('Not connected');
  });

  test('after: the Oura series are gone from the dashboard chart', async ({ page }) => {
    // The Strava rides were kept above, so EF is still plotted; Oura's HRV / resting HR are not.
    const chart = await hoverChart(page);
    await expect(chart.getByText(/^EF peak-20: \d+\.\d{2} W\/bpm$/)).toBeVisible();
    await expect(chart.getByText(/^HRV: /)).toHaveCount(0);
    await expect(chart.getByText(/^Resting HR: /)).toHaveCount(0);
  });

  test('after: the readiness score derived from Oura is gone from the dashboard', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await expect(page.getByRole('region', { name: 'Readiness score' })).toHaveCount(0);
  });
});

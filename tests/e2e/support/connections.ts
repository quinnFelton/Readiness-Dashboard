import { expect, type Locator, type Page } from '@playwright/test';

/** The provider card (a list item) on /settings/connections, by display name. */
export function providerCard(page: Page, displayName: string): Locator {
  return page.getByRole('listitem').filter({ has: page.getByText(displayName, { exact: true }) });
}

export async function openConnections(page: Page): Promise<void> {
  await page.goto('/settings/connections');
  await expect(page.getByRole('heading', { level: 1, name: 'Connections' })).toBeVisible();
}

/**
 * Clicks a button that is wired up by client-side React. A click that lands before hydration is
 * silently dropped, so retry the click until `done` holds (no fixed sleeps).
 */
export async function clickUntil(button: Locator, done: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await button.click({ timeout: 2_000 });
    await done();
  }).toPass({ timeout: 15_000 });
}

/** Answers the provider's authorize page with a redirect back to the app. */
export function redirectTo(location: string) {
  return { status: 302, headers: { location, 'cache-control': 'no-store' } } as const;
}

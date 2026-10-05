import { expect, test } from '@playwright/test';
import { clickUntil, openConnections, providerCard, redirectTo } from './support/connections';
import { authFile, USERS, WEB_URL } from './support/env';

// PLAN §10 flow 3: connect Strava. Same split as Oura: browser leg via page.route; the token
// exchange (POST https://www.strava.com/oauth/token, hardcoded in the adapter's client) is answered
// by the fetch stub in the API launcher. Serial: this user is mutated.
test.use({ storageState: authFile(USERS.stravaConnector) });
test.describe.configure({ mode: 'serial' });

const AUTHORIZE = 'https://www.strava.com/oauth/authorize**';

test.describe('connect Strava', () => {
  test('is listed as an activity source and starts as not connected', async ({ page }) => {
    await openConnections(page);
    const section = page.getByRole('region', { name: 'Activity source' });
    await expect(section).toBeVisible();
    await expect(providerCard(page, 'Strava')).toContainText('Not connected');
  });

  test('a callback without the required scope is refused', async ({ page }) => {
    await page.route(AUTHORIZE, async (route) => {
      const u = new URL(route.request().url());
      const back = new URL(u.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'e2e-strava-code');
      back.searchParams.set('state', u.searchParams.get('state')!);
      back.searchParams.set('scope', 'read'); // user unticked activity:read_all
      await route.fulfill(redirectTo(back.toString()));
    });
    await openConnections(page);
    await clickUntil(providerCard(page, 'Strava').getByRole('button', { name: 'Connect' }), () =>
      expect(page.getByRole('heading', { name: 'Connection failed' })).toBeVisible({
        timeout: 5_000,
      }),
    );
    await openConnections(page);
    await expect(providerCard(page, 'Strava')).toContainText('Not connected');
  });

  test('the OAuth round trip connects Strava as the activity source', async ({ page }) => {
    let authorizeUrl: URL | undefined;
    await page.route(AUTHORIZE, async (route) => {
      authorizeUrl = new URL(route.request().url());
      const back = new URL(authorizeUrl.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'e2e-strava-code');
      back.searchParams.set('state', authorizeUrl.searchParams.get('state')!);
      back.searchParams.set('scope', 'read,activity:read_all');
      await route.fulfill(redirectTo(back.toString()));
    });

    await openConnections(page);
    await clickUntil(providerCard(page, 'Strava').getByRole('button', { name: 'Connect' }), () =>
      expect(page).toHaveURL(/\/settings\/connections\?connected=strava$/, { timeout: 5_000 }),
    );

    expect(authorizeUrl?.searchParams.get('client_id')).toBe('e2e-strava-client');
    expect(authorizeUrl?.searchParams.get('scope')).toBe('activity:read_all');
    expect(authorizeUrl?.searchParams.get('redirect_uri')).toBe(
      `${WEB_URL}/settings/connections/strava/callback`,
    );

    await expect(
      page.getByRole('status').filter({ hasText: 'strava connected successfully' }),
    ).toBeVisible();
    const card = providerCard(page, 'Strava');
    await expect(card).toContainText('Connected');
    await expect(card.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    await expect(card.getByRole('radio', { name: 'Use Strava' })).toBeChecked();

    await page.reload();
    await expect(providerCard(page, 'Strava')).toContainText('Connected');
  });
});

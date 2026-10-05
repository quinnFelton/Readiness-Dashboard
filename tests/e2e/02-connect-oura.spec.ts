import { expect, test } from '@playwright/test';
import { clickUntil, openConnections, providerCard, redirectTo } from './support/connections';
import { authFile, USERS, WEB_URL } from './support/env';

// PLAN §10 flow 2: connect Oura. The browser leg (provider authorize page) is intercepted with
// page.route; the code→token exchange happens inside the API process and is answered by the stub in
// support/api-server.ts. This user is mutated, so the file runs serially.
test.use({ storageState: authFile(USERS.ouraConnector) });
test.describe.configure({ mode: 'serial' });

const AUTHORIZE = 'https://cloud.ouraring.com/oauth/authorize**';

test.describe('connect Oura', () => {
  test('starts as not connected', async ({ page }) => {
    await openConnections(page);
    await expect(providerCard(page, 'Oura')).toContainText('Not connected');
    await expect(providerCard(page, 'Oura').getByRole('button', { name: 'Connect' })).toBeVisible();
  });

  test('a denied authorization connects nothing and says so', async ({ page }) => {
    await page.route(AUTHORIZE, async (route) => {
      const u = new URL(route.request().url());
      const back = new URL(u.searchParams.get('redirect_uri')!);
      back.searchParams.set('error', 'access_denied');
      back.searchParams.set('state', u.searchParams.get('state')!);
      await route.fulfill(redirectTo(back.toString()));
    });
    await openConnections(page);
    await clickUntil(providerCard(page, 'Oura').getByRole('button', { name: 'Connect' }), () =>
      expect(page.getByRole('heading', { name: 'Connection cancelled' })).toBeVisible({
        timeout: 5_000,
      }),
    );

    await openConnections(page);
    await expect(providerCard(page, 'Oura')).toContainText('Not connected');
  });

  test('a tampered state is rejected by the API', async ({ page }) => {
    await page.route(AUTHORIZE, async (route) => {
      const u = new URL(route.request().url());
      const back = new URL(u.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'e2e-oura-code');
      back.searchParams.set('state', 'forged.state');
      await route.fulfill(redirectTo(back.toString()));
    });
    await openConnections(page);
    await clickUntil(providerCard(page, 'Oura').getByRole('button', { name: 'Connect' }), () =>
      expect(page.getByRole('heading', { name: 'Connection failed' })).toBeVisible({
        timeout: 5_000,
      }),
    );
    await expect(
      page.getByRole('alert').filter({ hasText: 'invalid or has expired' }),
    ).toBeVisible();

    await openConnections(page);
    await expect(providerCard(page, 'Oura')).toContainText('Not connected');
  });

  test('the OAuth round trip connects Oura', async ({ page }) => {
    let authorizeUrl: URL | undefined;
    await page.route(AUTHORIZE, async (route) => {
      authorizeUrl = new URL(route.request().url());
      const back = new URL(authorizeUrl.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'e2e-oura-code');
      back.searchParams.set('state', authorizeUrl.searchParams.get('state')!);
      await route.fulfill(redirectTo(back.toString()));
    });

    await openConnections(page);
    await clickUntil(providerCard(page, 'Oura').getByRole('button', { name: 'Connect' }), () =>
      expect(page).toHaveURL(/\/settings\/connections\?connected=oura$/, { timeout: 5_000 }),
    );

    // The app sent the user to Oura with the right client, scopes and a return URL on this app.
    expect(authorizeUrl?.searchParams.get('client_id')).toBe('e2e-oura-client');
    expect(authorizeUrl?.searchParams.get('response_type')).toBe('code');
    expect(authorizeUrl?.searchParams.get('scope')).toContain('daily');
    expect(authorizeUrl?.searchParams.get('redirect_uri')).toBe(
      `${WEB_URL}/settings/connections/oura/callback`,
    );

    await expect(
      page.getByRole('status').filter({ hasText: 'oura connected successfully' }),
    ).toBeVisible();
    const card = providerCard(page, 'Oura');
    await expect(card).toContainText('Connected');
    await expect(card).not.toContainText('Not connected');
    await expect(card.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    // Connecting also enrols Oura as an active daily-metrics source.
    await expect(card.getByRole('checkbox', { name: 'Use Oura' })).toBeChecked();

    // Persisted, not just rendered: survives a reload.
    await page.reload();
    await expect(providerCard(page, 'Oura')).toContainText('Connected');
  });
});

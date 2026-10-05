import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { clickUntil, openConnections, providerCard, redirectTo } from './support/connections';
import { API_URL, authFile, TERRA_SIGNING_SECRET, USERS, WEB_URL } from './support/env';

// PLAN §10 flow 4: connect Terra (Zepp). Terra is a widget flow, not OAuth:
//   POST /connections/terra/start  → API asks Terra for a widget session (stubbed in the launcher)
//   browser → widget URL           → intercepted here with page.route and answered the way Terra
//                                    does: a signed `auth` webhook to the API (PLAN §5.3, the
//                                    reliable twin of the browser redirect) + a redirect back to
//                                    the app's success URL.
// Serial: this user is mutated.
test.use({ storageState: authFile(USERS.terraConnector) });
test.describe.configure({ mode: 'serial' });

const WIDGET = 'https://widget.tryterra.co/**';
const TERRA_USER_ID = 'terra-e2e-user';

/** Header Terra sends: `terra-signature: t=<unix>,v1=hex(HMAC-SHA256(secret, "<t>.<raw body>"))`. */
function sign(body: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', TERRA_SIGNING_SECRET).update(`${t}.`).update(body).digest('hex');
  return `t=${t},v1=${v1}`;
}

test.describe('connect Terra', () => {
  test('is listed as a daily-metrics source and starts as not connected', async ({ page }) => {
    await openConnections(page);
    await expect(page.getByRole('region', { name: 'Daily metrics sources' })).toBeVisible();
    await expect(providerCard(page, 'Zepp (via Terra)')).toContainText('Not connected');
  });

  test('the widget round trip connects Terra', async ({ page, request }) => {
    let widgetUrl: URL | undefined;
    let webhookStatus: number | undefined;
    await page.route(WIDGET, async (route) => {
      widgetUrl = new URL(route.request().url());
      const referenceId = widgetUrl.searchParams.get('reference_id')!;

      // Terra's server → our API: signed `auth` webhook for this reference_id.
      const body = JSON.stringify({
        type: 'auth',
        status: 'success',
        user: { user_id: TERRA_USER_ID, reference_id: referenceId, provider: 'ZEPP' },
      });
      const res = await request.post(`${API_URL}/api/v1/webhooks/terra`, {
        data: body,
        headers: { 'content-type': 'application/json', 'terra-signature': sign(body) },
      });
      webhookStatus = res.status();

      // Terra's widget → browser: back to the success URL the API supplied.
      const back = new URL(widgetUrl.searchParams.get('success')!);
      back.searchParams.set('user_id', TERRA_USER_ID);
      back.searchParams.set('reference_id', referenceId);
      back.searchParams.set('resource', 'ZEPP');
      await route.fulfill(redirectTo(back.toString()));
    });

    await openConnections(page);
    await clickUntil(
      providerCard(page, 'Zepp (via Terra)').getByRole('button', { name: 'Connect' }),
      () => expect(page).toHaveURL(new RegExp(`^${WEB_URL}/settings\\?`), { timeout: 5_000 }),
    );

    // The API handed the browser a widget session whose reference_id is our user id, and the
    // success redirect points back at this app.
    expect(widgetUrl?.searchParams.get('reference_id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(widgetUrl?.searchParams.get('success')).toContain(`${WEB_URL}/settings`);
    expect(webhookStatus).toBe(200);

    // The connection exists server-side and is shown on the connections page.
    await openConnections(page);
    const card = providerCard(page, 'Zepp (via Terra)');
    await expect(card).toContainText('Connected');
    await expect(card).not.toContainText('Not connected');
    await expect(card.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  });

  test('an unsigned webhook is rejected and connects nothing', async ({ request }) => {
    const body = JSON.stringify({
      type: 'auth',
      status: 'success',
      user: { user_id: 'attacker', reference_id: '00000000-0000-4000-8000-000000000000' },
    });
    const res = await request.post(`${API_URL}/api/v1/webhooks/terra`, {
      data: body,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status()).toBe(401);
    const bad = await request.post(`${API_URL}/api/v1/webhooks/terra`, {
      data: body,
      headers: {
        'content-type': 'application/json',
        'terra-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
      },
    });
    expect(bad.status()).toBe(401);
  });
});

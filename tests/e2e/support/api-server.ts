// API launcher for e2e. Same Express app as production (createApp), but every outbound HTTP call
// to a third party is answered here, and any other external host is refused (CLAUDE.md rule 10).
//
// Why a fetch wrapper: the OAuth code→token exchange, Strava calls and the Terra widget session all
// run inside this process, so Playwright's page.route cannot see them. The provider adapters read
// `globalThis.fetch` when they are constructed (createApp → registerDefaultAdapters), so the wrapper
// MUST be installed before createApp() runs; hence the dynamic import below.

export {}; // module scope, for top-level await

const realFetch = globalThis.fetch.bind(globalThis);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

function formBody(init: RequestInit | undefined): URLSearchParams {
  const b = init?.body;
  return new URLSearchParams(
    typeof b === 'string' ? b : b instanceof URLSearchParams ? b.toString() : '',
  );
}

const OURA_CODE = 'e2e-oura-code';
const STRAVA_CODE = 'e2e-strava-code';

const handlers: Record<string, Handler> = {
  // Oura: https://cloud.ouraring.com/docs/authentication (token), /v2/usercollection/* (data).
  'POST api.ouraring.com/oauth/token': (_u, init) => {
    const f = formBody(init);
    if (f.get('grant_type') === 'authorization_code' && f.get('code') !== OURA_CODE) {
      return json({ error: 'invalid_grant' }, 400);
    }
    return json({
      access_token: 'e2e-oura-access',
      refresh_token: 'e2e-oura-refresh',
      expires_in: 86_400,
      token_type: 'bearer',
    });
  },
  'GET api.ouraring.com/v2/usercollection/personal_info': () => json({ id: 'oura-e2e-athlete' }),

  // Strava: https://developers.strava.com/docs/authentication/ (hardcoded URLs in client.ts).
  'POST www.strava.com/oauth/token': (_u, init) => {
    const f = formBody(init);
    if (f.get('grant_type') === 'authorization_code' && f.get('code') !== STRAVA_CODE) {
      return json({ message: 'Bad Request' }, 400);
    }
    return json({
      access_token: 'e2e-strava-access',
      refresh_token: 'e2e-strava-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 21_600,
      athlete: { id: 424242 },
    });
  },

  // Terra widget session: the stub echoes what the API asked for into the widget URL, so the
  // browser-side page.route can play "Terra" and redirect to the right place with the right ids.
  'POST access.tryterra.co/api/widget/session': async (_u, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      reference_id?: string;
      auth_success_redirect_url?: string;
    };
    const widget = new URL('https://widget.tryterra.co/e2e-session');
    widget.searchParams.set('reference_id', body.reference_id ?? '');
    widget.searchParams.set('success', body.auth_success_redirect_url ?? '');
    return json({ url: widget.toString(), session_id: 'e2e-terra-session' });
  },
  // Terra historical backfill (requested after the `auth` webhook); data would arrive by webhook.
  'GET api.tryterra.co/v2/sleep': () => json({ status: 'success' }),
};

function hostKey(method: string, url: URL): string {
  return `${method} ${url.host}${url.pathname}`;
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request ? input : undefined;
  const url = new URL(req ? req.url : String(input));
  if (LOCAL_HOSTS.has(url.hostname)) return realFetch(input, init);

  const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
  const handler = handlers[hostKey(method, url)];
  if (!handler) {
    // Fail loudly (never a silent real call). Path only: the query may carry tokens/codes.
    throw new Error(`e2e: blocked outbound ${method} ${url.host}${url.pathname}`);
  }
  return handler(url, init);
}) as typeof fetch;

const { createApp } = await import('../../../apps/api/src/app');

const port = Number(process.env.PORT ?? 4100);
createApp().listen(port, () => {
  console.log(`e2e api listening on http://localhost:${port}`);
});

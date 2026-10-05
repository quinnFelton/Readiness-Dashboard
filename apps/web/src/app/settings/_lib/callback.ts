// PLAN §9 / phase 6c: OAuth callback handling, kept pure + injectable so it is unit-testable.
// SECURITY: `code` and `state` are forwarded to the API verbatim and never logged, persisted,
// or included in returned messages/errors.

export type CallbackQuery = Record<string, string | string[] | undefined>;

export type CallbackOutcome =
  | { status: 'success' }
  | { status: 'denied'; message: string }
  | { status: 'error'; message: string };

export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

const PROVIDER_RE = /^[a-z0-9_-]{1,32}$/;

/** Rebuilds the query string exactly as received (first value of each key; keeps order). */
export function buildQueryString(query: CallbackQuery): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    const val = Array.isArray(v) ? v[0] : v;
    if (typeof val === 'string') sp.append(k, val);
  }
  return sp.toString();
}

export async function completeOAuthCallback(
  provider: string,
  query: CallbackQuery,
  apiFetch: ApiFetch,
): Promise<CallbackOutcome> {
  if (!PROVIDER_RE.test(provider)) return { status: 'error', message: 'Unknown provider.' };

  // Provider-reported error (e.g. user denied): do not call the API.
  const providerError = Array.isArray(query.error) ? query.error[0] : query.error;
  if (providerError) {
    return providerError === 'access_denied'
      ? {
          status: 'denied',
          message: 'You denied access, so nothing was connected. You can try again any time.',
        }
      : {
          status: 'error',
          message: 'The provider reported an error while connecting. Please try again.',
        };
  }

  const qs = buildQueryString(query);
  const has = (k: string) => {
    const v = Array.isArray(query[k]) ? query[k]?.[0] : query[k];
    return typeof v === 'string' && v.length > 0;
  };
  if (!has('code') || !has('state')) {
    return {
      status: 'error',
      message: 'The callback was missing required details. Please start again.',
    };
  }

  let res: Response;
  try {
    res = await apiFetch(`/connections/${provider}/callback?${qs}`);
  } catch {
    return { status: 'error', message: 'Could not reach the server. Please try again.' };
  }
  if (res.ok) return { status: 'success' };
  if (res.status === 400) {
    return {
      status: 'error',
      message: 'This connection link is invalid or has expired. Please start the connection again.',
    };
  }
  if (res.status >= 400 && res.status < 500) {
    return { status: 'error', message: 'The connection could not be completed. Please try again.' };
  }
  return { status: 'error', message: 'Something went wrong on our side. Please try again later.' };
}

/** Sign-in redirect that returns to the same callback URL, query included. */
export function signInRedirectFor(provider: string, query: CallbackQuery): string {
  const qs = buildQueryString(query);
  const back = `/settings/connections/${provider}/callback${qs ? `?${qs}` : ''}`;
  return `/login?callbackUrl=${encodeURIComponent(back)}`;
}

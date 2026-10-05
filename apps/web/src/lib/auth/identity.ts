import type { UserRole } from '@rd/shared-types';

// Web half of the OAuth identity check (apps/api/src/auth/identity.ts documents the protocol).
// Web Crypto only, so this file is safe in every Next runtime (the NextAuth config is shared with
// middleware). Signs "who is this email?" requests with a key derived from NEXTAUTH_SECRET.

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

export async function signIdentityRequest(
  email: string,
  nowSec: number,
  secret: string,
): Promise<string> {
  const key = await hmac(enc.encode(secret), 'rd:web-identity-key:v1');
  return b64url(await hmac(key, `rd-web-identity.v1.${nowSec}.${email}`));
}

export interface ResolvedUser {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
}

/**
 * Maps a Google-authenticated email to an existing user, or null (unknown email, bad response, API
 * down: all refuse the sign-in; there is no auto-provisioning).
 */
export async function resolveUserByEmail(
  email: string,
  opts: { apiUrl: string; secret: string; nowSec?: number; fetch?: typeof fetch },
): Promise<ResolvedUser | null> {
  const ts = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const f = opts.fetch ?? fetch;
  try {
    const res = await f(`${opts.apiUrl}/api/v1/auth/oauth-identity`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rd-ts': String(ts),
        'x-rd-sig': await signIdentityRequest(email, ts, opts.secret),
      },
      body: JSON.stringify({ email }),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const { user } = (await res.json()) as { user?: ResolvedUser };
    return user ?? null;
  } catch {
    return null;
  }
}

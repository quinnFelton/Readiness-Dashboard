import { createHmac, timingSafeEqual } from 'node:crypto';

// Security review H3: production sign-in is OAuth (Google) in the web app, restricted to emails that
// already exist in `users` (the dashboard is invite-only). The web server cannot read Postgres, so
// after Google authenticates the person it asks the API "which user is this email?". That call is
// authenticated by an HMAC the web server computes with a key derived from NEXTAUTH_SECRET, so only
// the web server can ask, and nobody can use the endpoint to enumerate accounts.
//
//   x-rd-ts   unix seconds
//   x-rd-sig  base64url( HMAC-SHA256( key, "rd-web-identity.v1.<ts>.<email>" ) )
//   key     = HMAC-SHA256( NEXTAUTH_SECRET, "rd:web-identity-key:v1" )   (not the raw secret: L7)
//
// apps/web/src/lib/auth/identity.ts signs with Web Crypto; identity.test.ts there proves both sides
// agree. The window is short so a captured request cannot be replayed later.

export const IDENTITY_TOLERANCE_SEC = 60;

const key = (secret: string) =>
  createHmac('sha256', secret).update('rd:web-identity-key:v1').digest();

export function signIdentityRequest(email: string, nowSec: number, secret: string): string {
  return createHmac('sha256', key(secret))
    .update(`rd-web-identity.v1.${nowSec}.${email}`)
    .digest('base64url');
}

/** True only for a fresh timestamp and a matching signature (constant-time compare). */
export function verifyIdentityRequest(
  input: { email: string; ts: string | undefined; sig: string | undefined },
  opts: { secret: string; nowSec: number },
): boolean {
  const ts = Number(input.ts);
  if (!input.sig || !Number.isInteger(ts)) return false;
  if (Math.abs(opts.nowSec - ts) > IDENTITY_TOLERANCE_SEC) return false;
  const want = Buffer.from(signIdentityRequest(input.email, ts, opts.secret), 'base64url');
  const got = Buffer.from(input.sig, 'base64url');
  return got.length === want.length && timingSafeEqual(got, want);
}

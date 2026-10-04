import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ApiTokenClaims, UserRole } from '@rd/shared-types';

// HS256 JWT between the web app and the API. See ./README.md.
// Hand-rolled on node:crypto (no dependency); only HS256 is ever accepted, so there is
// no alg-confusion surface.

export const TOKEN_ISSUER = 'rd-web';
export const TOKEN_AUDIENCE = 'rd-api';
export const DEFAULT_TOKEN_TTL_SEC = 300;

const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');

function sign(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export function getSigningSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('NEXTAUTH_SECRET must be set (>=16 chars) to verify API tokens');
  }
  return secret;
}

export function signApiToken(
  input: { userId: string; role: UserRole },
  opts: { secret?: string; ttlSec?: number; nowSec: number },
): string {
  const claims: ApiTokenClaims = {
    sub: input.userId,
    role: input.role,
    iss: TOKEN_ISSUER,
    aud: TOKEN_AUDIENCE,
    iat: opts.nowSec,
    exp: opts.nowSec + (opts.ttlSec ?? DEFAULT_TOKEN_TTL_SEC),
  };
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = sign(`${head}.${body}`, opts.secret ?? getSigningSecret());
  return `${head}.${body}.${b64url(sig)}`;
}

/** Returns claims, or null for ANY invalid token (bad shape, signature, alg, iss/aud, expiry). */
export function verifyApiToken(
  token: string,
  opts: { secret?: string; nowSec: number },
): ApiTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];

  try {
    const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as { alg?: unknown };
    if (header.alg !== 'HS256') return null;

    const expected = sign(`${head}.${body}`, opts.secret ?? getSigningSecret());
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

    const c = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as Partial<ApiTokenClaims>;
    if (c.iss !== TOKEN_ISSUER || c.aud !== TOKEN_AUDIENCE) return null;
    if (typeof c.sub !== 'string' || typeof c.exp !== 'number' || typeof c.iat !== 'number') {
      return null;
    }
    if (c.exp <= opts.nowSec) return null;
    return c as ApiTokenClaims;
  } catch {
    return null;
  }
}

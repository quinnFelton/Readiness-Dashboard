import 'server-only';
import { createHmac } from 'node:crypto';
import type { ApiTokenClaims, UserRole } from '@rd/shared-types';

// Mints the short-lived HS256 token the API verifies (apps/api/src/auth/token.ts).
// Server-only: NEXTAUTH_SECRET must never reach the client bundle.
export function mintApiToken(user: { id: string; role: UserRole }, ttlSec = 300): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET is not set');
  const now = Math.floor(Date.now() / 1000);
  const claims: ApiTokenClaims = {
    sub: user.id,
    role: user.role,
    iss: 'rd-web',
    aud: 'rd-api',
    iat: now,
    exp: now + ttlSec,
  };
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const data = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(claims)}`;
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}

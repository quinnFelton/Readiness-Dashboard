import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Signed OAuth `state`: binds a connect flow to (user, provider) and a short expiry, so the
// callback can't be replayed by or for another user (CSRF protection, PLAN §12).

const TTL_SEC = 600;

const b64 = (b: Buffer) => b.toString('base64url');
const mac = (secret: Buffer, data: string) =>
  createHmac('sha256', secret).update(`oauth-state.${data}`).digest();

export function signOAuthState(
  input: { userId: string; provider: string; nowSec: number },
  secret: Buffer,
): string {
  const payload = b64(
    Buffer.from(
      JSON.stringify({
        u: input.userId,
        p: input.provider,
        exp: input.nowSec + TTL_SEC,
        n: randomBytes(8).toString('hex'),
      }),
    ),
  );
  return `${payload}.${b64(mac(secret, payload))}`;
}

export function verifyOAuthState(
  state: string | undefined,
  expected: { userId: string; provider: string; nowSec: number },
  secret: Buffer,
): boolean {
  if (!state) return false;
  const [payload, sig, ...rest] = state.split('.');
  if (!payload || !sig || rest.length > 0) return false;
  const want = mac(secret, payload);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
  try {
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      u?: unknown;
      p?: unknown;
      exp?: unknown;
    };
    return (
      c.u === expected.userId &&
      c.p === expected.provider &&
      typeof c.exp === 'number' &&
      c.exp > expected.nowSec
    );
  } catch {
    return false;
  }
}

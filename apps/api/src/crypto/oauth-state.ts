import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Signed OAuth `state`: binds a connect flow to (user, provider) and a short expiry, so the
// callback can't be replayed by or for another user (CSRF protection, PLAN §12).

const TTL_SEC = 600;
/** HMAC-SHA256 key floor. Security review H1: an empty key used to "work" and made state forgeable. */
export const MIN_SECRET_BYTES = 32;

function assertStrong(secret: Buffer): void {
  if (secret.length < MIN_SECRET_BYTES) {
    // Fail closed: a misconfigured deployment must not silently run with CSRF protection off.
    throw new Error(`OAuth state secret must be at least ${MIN_SECRET_BYTES} bytes`);
  }
}

/**
 * The state-signing key. Production requires its own OAUTH_STATE_SECRET (Secrets Manager, only the
 * REST API reads it). Outside production a key is derived from TOKEN_ENCRYPTION_KEY with a distinct
 * label, so the AES token key's bytes are never reused as an HMAC key.
 */
export function oauthStateSecretFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const explicit = env.OAUTH_STATE_SECRET;
  if (explicit) {
    const key = Buffer.from(explicit, 'utf8');
    assertStrong(key);
    return key;
  }
  if (env.NODE_ENV === 'production') throw new Error('OAUTH_STATE_SECRET is not set');
  const base = Buffer.from(env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  assertStrong(base);
  return createHmac('sha256', base).update('rd:oauth-state-key:v1').digest();
}

const b64 = (b: Buffer) => b.toString('base64url');
const mac = (secret: Buffer, data: string) =>
  createHmac('sha256', secret).update(`oauth-state.${data}`).digest();

export function signOAuthState(
  input: { userId: string; provider: string; nowSec: number },
  secret: Buffer,
): string {
  assertStrong(secret);
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
  assertStrong(secret);
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

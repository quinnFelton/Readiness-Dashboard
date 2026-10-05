import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signOAuthState, verifyOAuthState } from './oauth-state';
import { KmsTokenCipher, LocalAesGcmCipher, createTokenCipher } from './token-cipher';

const key = randomBytes(32).toString('base64');

describe('LocalAesGcmCipher', () => {
  it('round-trips and uses a fresh IV each time', async () => {
    const c = new LocalAesGcmCipher(key);
    const a = await c.encrypt('secret-token', 'u1:oura');
    const b = await c.encrypt('secret-token', 'u1:oura');
    expect(a.equals(b)).toBe(false);
    expect(a.includes(Buffer.from('secret-token'))).toBe(false);
    expect(await c.decrypt(a, 'u1:oura')).toBe('secret-token');
  });

  it('fails on wrong context, wrong key, or tampering', async () => {
    const c = new LocalAesGcmCipher(key);
    const ct = await c.encrypt('t', 'u1:oura');
    await expect(c.decrypt(ct, 'u2:oura')).rejects.toThrow();
    await expect(
      new LocalAesGcmCipher(randomBytes(32).toString('base64')).decrypt(ct, 'u1:oura'),
    ).rejects.toThrow();
    const bad = Buffer.from(ct);
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1;
    await expect(c.decrypt(bad, 'u1:oura')).rejects.toThrow();
    await expect(c.decrypt(Buffer.from('short'))).rejects.toThrow();
  });

  it('rejects a missing or wrong-length key without echoing it', () => {
    expect(() => new LocalAesGcmCipher(undefined)).toThrow(/32-byte/);
    expect(() => new LocalAesGcmCipher('c2hvcnQ=')).toThrow(/32-byte/);
  });
});

describe('createTokenCipher / KmsTokenCipher', () => {
  it('picks local in dev and the KMS envelope cipher in prod with KMS_KEY_ID', async () => {
    expect(createTokenCipher({ TOKEN_ENCRYPTION_KEY: key } as NodeJS.ProcessEnv)).toBeInstanceOf(
      LocalAesGcmCipher,
    );
    const prod = createTokenCipher({
      NODE_ENV: 'production',
      KMS_KEY_ID: 'k',
    } as NodeJS.ProcessEnv);
    expect(prod).toBeInstanceOf(KmsTokenCipher);
    // No KMS_ENCRYPTED_DATA_KEY configured: fails clearly, before any AWS call.
    await expect(prod.encrypt('x')).rejects.toThrow(/KMS_ENCRYPTED_DATA_KEY/);
  });
});

describe('oauth state', () => {
  const secret = randomBytes(32);
  const base = { userId: 'u1', provider: 'oura', nowSec: 1000 };

  it('verifies for the same user+provider before expiry', () => {
    const s = signOAuthState(base, secret);
    expect(verifyOAuthState(s, base, secret)).toBe(true);
  });
  it('rejects other user, other provider, expiry, tampering, wrong secret, garbage', () => {
    const s = signOAuthState(base, secret);
    expect(verifyOAuthState(s, { ...base, userId: 'u2' }, secret)).toBe(false);
    expect(verifyOAuthState(s, { ...base, provider: 'strava' }, secret)).toBe(false);
    expect(verifyOAuthState(s, { ...base, nowSec: 1601 }, secret)).toBe(false);
    expect(verifyOAuthState(s + 'x', base, secret)).toBe(false);
    expect(verifyOAuthState(s, base, randomBytes(32))).toBe(false);
    expect(verifyOAuthState(undefined, base, secret)).toBe(false);
    expect(verifyOAuthState('a.b.c', base, secret)).toBe(false);
  });
});

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signApiToken, verifyApiToken } from './token';

const SECRET = 'unit-secret-unit-secret-unit';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const forge = (header: object, claims: object, secret = SECRET) => {
  const data = `${b64(header)}.${b64(claims)}`;
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
};
const valid = { sub: 'u', iss: 'rd-web', aud: 'rd-api', iat: 1000, exp: 1300 };

describe('verifyApiToken', () => {
  it('round-trips claims', () => {
    const t = signApiToken(
      { userId: 'u1', role: 'master' },
      { secret: SECRET, nowSec: 1000, ttlSec: 60 },
    );
    expect(verifyApiToken(t, { secret: SECRET, nowSec: 1059 })).toMatchObject({
      sub: 'u1',
      role: 'master',
      iss: 'rd-web',
      aud: 'rd-api',
      iat: 1000,
      exp: 1060,
    });
  });
  it('expires exactly at exp (boundary)', () => {
    const t = signApiToken(
      { userId: 'u', role: 'user' },
      { secret: SECRET, nowSec: 1000, ttlSec: 60 },
    );
    expect(verifyApiToken(t, { secret: SECRET, nowSec: 1059 })).not.toBeNull();
    expect(verifyApiToken(t, { secret: SECRET, nowSec: 1060 })).toBeNull();
  });
  it('accepts a hand-forged token that is correctly signed (sanity of forge helper)', () => {
    expect(
      verifyApiToken(forge({ alg: 'HS256' }, valid), { secret: SECRET, nowSec: 1100 })?.sub,
    ).toBe('u');
  });
  it('rejects wrong secret', () => {
    expect(
      verifyApiToken(forge({ alg: 'HS256' }, valid, 'other-other-other-other'), {
        secret: SECRET,
        nowSec: 1100,
      }),
    ).toBeNull();
  });
  it('rejects alg none / HS512 / missing alg even if signed', () => {
    for (const alg of ['none', 'HS512', undefined]) {
      expect(verifyApiToken(forge({ alg }, valid), { secret: SECRET, nowSec: 1100 })).toBeNull();
    }
  });
  it('rejects wrong iss, wrong aud', () => {
    expect(
      verifyApiToken(forge({ alg: 'HS256' }, { ...valid, iss: 'x' }), {
        secret: SECRET,
        nowSec: 1100,
      }),
    ).toBeNull();
    expect(
      verifyApiToken(forge({ alg: 'HS256' }, { ...valid, aud: 'x' }), {
        secret: SECRET,
        nowSec: 1100,
      }),
    ).toBeNull();
  });
  it('rejects missing/non-string sub and non-numeric exp/iat', () => {
    expect(
      verifyApiToken(forge({ alg: 'HS256' }, { ...valid, sub: 5 }), {
        secret: SECRET,
        nowSec: 1100,
      }),
    ).toBeNull();
    expect(
      verifyApiToken(forge({ alg: 'HS256' }, { ...valid, exp: '9999999999' }), {
        secret: SECRET,
        nowSec: 1100,
      }),
    ).toBeNull();
    expect(
      verifyApiToken(forge({ alg: 'HS256' }, { ...valid, iat: undefined }), {
        secret: SECRET,
        nowSec: 1100,
      }),
    ).toBeNull();
  });
  it('rejects bad shapes without throwing', () => {
    for (const t of ['', 'a', 'a.b', 'a.b.c.d', '..', '!!.!!.!!']) {
      expect(verifyApiToken(t, { secret: SECRET, nowSec: 1 })).toBeNull();
    }
  });
  it('rejects truncated / empty signature', () => {
    const t = signApiToken({ userId: 'u', role: 'user' }, { secret: SECRET, nowSec: 1000 });
    const [h, b, s] = t.split('.');
    expect(
      verifyApiToken(`${h}.${b}.${s!.slice(0, 10)}`, { secret: SECRET, nowSec: 1001 }),
    ).toBeNull();
    expect(verifyApiToken(`${h}.${b}.`, { secret: SECRET, nowSec: 1001 })).toBeNull();
  });
  it('rejects tampered payload (role escalation) with original signature', () => {
    const t = signApiToken({ userId: 'u', role: 'user' }, { secret: SECRET, nowSec: 1000 });
    const [h, , s] = t.split('.');
    expect(
      verifyApiToken(`${h}.${b64({ ...valid, sub: 'admin' })}.${s}`, {
        secret: SECRET,
        nowSec: 1001,
      }),
    ).toBeNull();
  });
  it('throws (fails closed) when no secret configured', () => {
    const prev = process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    try {
      // Throws inside try/catch of verify only after header parse; sign must throw.
      expect(() => signApiToken({ userId: 'u', role: 'user' }, { nowSec: 1 })).toThrow();
      process.env.NEXTAUTH_SECRET = 'short';
      expect(() => signApiToken({ userId: 'u', role: 'user' }, { nowSec: 1 })).toThrow();
    } finally {
      if (prev !== undefined) process.env.NEXTAUTH_SECRET = prev;
    }
  });
});

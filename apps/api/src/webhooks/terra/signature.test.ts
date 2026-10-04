import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signTerraPayload, verifyTerraSignature } from './signature';

const SECRET = 'whsec_test_secret';
const NOW = 1_800_000_000;
const body = Buffer.from('{"type":"sleep","data":[]}');
const verify = (b: Buffer, h: string | undefined, secret = SECRET, now = NOW) =>
  verifyTerraSignature(b, h, secret, now, 300);

describe('verifyTerraSignature', () => {
  it('accepts a valid signature', () => {
    expect(verify(body, signTerraPayload(body, SECRET, NOW))).toEqual({ ok: true });
  });

  it('matches the documented construction HMAC-SHA256("<t>.<raw body>")', () => {
    const mac = createHmac('sha256', SECRET).update(`${NOW}.${body.toString()}`).digest('hex');
    expect(verify(body, `t=${NOW},v1=${mac}`)).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    const h = signTerraPayload(body, SECRET, NOW);
    expect(verify(Buffer.from('{"type":"sleep","data":[1]}'), h)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('rejects the wrong secret', () => {
    expect(verify(body, signTerraPayload(body, 'other', NOW))).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('rejects stale and far-future timestamps (valid MAC)', () => {
    expect(verify(body, signTerraPayload(body, SECRET, NOW - 301))).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(verify(body, signTerraPayload(body, SECRET, NOW + 301))).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(verify(body, signTerraPayload(body, SECRET, NOW - 300)).ok).toBe(true);
  });

  it('a timestamp edited after signing fails (t is part of the MAC)', () => {
    const mac = signTerraPayload(body, SECRET, NOW - 1000).split('v1=')[1]!;
    expect(verify(body, `t=${NOW},v1=${mac}`)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it.each([
    [undefined, 'missing'],
    ['', 'missing'],
    ['garbage', 'malformed'],
    [`t=${NOW}`, 'malformed'],
    ['v1=abcd', 'malformed'],
    [`t=abc,v1=${'0'.repeat(64)}`, 'malformed'],
  ])('rejects header %j as %s', (h, reason) => {
    expect(verify(body, h as string | undefined)).toEqual({ ok: false, reason });
  });

  it('rejects non-hex / wrong-length v1 without throwing', () => {
    expect(verify(body, `t=${NOW},v1=zz`).ok).toBe(false);
    expect(verify(body, `t=${NOW},v1=${'a'.repeat(62)}`).ok).toBe(false);
  });

  it('ignores non-v1 schemes (no downgrade)', () => {
    const mac = createHmac('sha256', SECRET).update(`${NOW}.`).update(body).digest('hex');
    expect(verify(body, `t=${NOW},v0=${mac}`)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('accepts when any one of several v1 values is valid', () => {
    const good = signTerraPayload(body, SECRET, NOW).split('v1=')[1]!;
    expect(verify(body, `t=${NOW},v1=${'0'.repeat(64)},v1=${good}`).ok).toBe(true);
  });
});

import { createHmac, timingSafeEqual } from 'node:crypto';

// PLAN §5.3 / §12, CLAUDE.md rule 7. Runs BEFORE the body is parsed.
// Scheme (https://docs.tryterra.co/unified-api/integration-setup/setting-up-data-destinations/webhooks.md):
//   header  terra-signature: t=<unix seconds>,v1=<hex>
//   v1 = HMAC-SHA256(signing_secret, "<t>.<raw body>"), constant-time compare,
//   verify against the RAW unaltered body, ignore every scheme other than v1 (anti-downgrade).
// Terra documents no timestamp tolerance, so replay window is config (rule 9).

export type SignatureResult =
  { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' };

const HEX64 = /^[0-9a-f]{64}$/i;
const DIGITS = /^\d{1,12}$/;

export function verifyTerraSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  nowSec: number,
  toleranceSec: number,
): SignatureResult {
  if (!header) return { ok: false, reason: 'missing' };

  let t: string | undefined;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') v1.push(v);
  }
  if (!t || !DIGITS.test(t) || v1.length === 0) return { ok: false, reason: 'malformed' };

  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();

  // Evaluate every candidate without short-circuiting on position; length is public (always 32).
  let match = false;
  for (const cand of v1) {
    if (!HEX64.test(cand)) continue;
    if (timingSafeEqual(expected, Buffer.from(cand, 'hex'))) match = true;
  }
  if (!match) return { ok: false, reason: 'mismatch' };

  // Timestamp is only trustworthy once the MAC checks out; reject both stale and far-future.
  if (Math.abs(nowSec - Number(t)) > toleranceSec) return { ok: false, reason: 'stale' };
  return { ok: true };
}

/** Test/dev helper: produce a header Terra would send. */
export function signTerraPayload(rawBody: Buffer | string, secret: string, tSec: number): string {
  const mac = createHmac('sha256', secret).update(`${tSec}.`).update(rawBody).digest('hex');
  return `t=${tSec},v1=${mac}`;
}

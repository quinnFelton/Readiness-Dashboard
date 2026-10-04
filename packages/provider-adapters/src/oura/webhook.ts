/// <reference types="node" />
import { createHmac, timingSafeEqual } from 'node:crypto';

// Oura webhook primitives. Source: spec 1.41 `webhookDocs` (docs/openapi-excerpt.json), originally
// https://cloud.ouraring.com/v2/docs ("Webhook Subscription Routes"):
//   - POST headers: x-oura-signature, x-oura-timestamp
//   - signature = HMAC-SHA256(key = client secret, message = timestamp + body), hex, UPPERCASE
//   - body fields: event_type, data_type, object_id, event_time, user_id
//   - GET verification: query verification_token + challenge -> respond JSON { challenge }
// The docs do not state the unit of x-oura-timestamp (example "1234567890" suggests epoch seconds), so
// freshness accepts seconds or milliseconds.

/** Constant-time string compare (length-leak only, which is not secret here). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function ouraSignature(clientSecret: string, timestamp: string, body: string): string {
  return createHmac('sha256', clientSecret)
    .update(timestamp + body)
    .digest('hex')
    .toUpperCase();
}

export type SignatureFailure = 'missing_header' | 'bad_signature' | 'stale_timestamp';

export interface SignatureCheck {
  ok: boolean;
  reason?: SignatureFailure;
}

/**
 * Verifies a delivery BEFORE the payload is used (CLAUDE.md rule 7).
 *  1. HMAC over the exact bytes received (constant-time compare).
 *  2. If that fails, over the canonical re-serialisation JSON.stringify(JSON.parse(body)) — the docs' own
 *     reference implementation signs JSON.stringify(body). The parse result is discarded; only the hash
 *     comparison can accept the request.
 *  3. Timestamp freshness (replay window), checked after the HMAC so no timing oracle exists for it.
 */
export function verifyOuraSignature(args: {
  clientSecret: string;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: string;
  now: Date;
  toleranceSec: number;
}): SignatureCheck {
  const { clientSecret, signature, timestamp, rawBody, now, toleranceSec } = args;
  if (!clientSecret) return { ok: false, reason: 'bad_signature' }; // never accept when unconfigured
  if (!signature || !timestamp) return { ok: false, reason: 'missing_header' };

  const received = signature.trim().toUpperCase();
  const candidates = [rawBody];
  try {
    const canonical = JSON.stringify(JSON.parse(rawBody));
    if (canonical !== rawBody) candidates.push(canonical);
  } catch {
    /* not JSON: raw candidate only */
  }
  // Evaluate every candidate (no early exit) to keep timing independent of which matched.
  let matched = false;
  for (const c of candidates) {
    if (safeEqual(ouraSignature(clientSecret, timestamp, c), received)) matched = true;
  }
  if (!matched) return { ok: false, reason: 'bad_signature' };

  const t = Number(timestamp);
  if (!Number.isFinite(t)) return { ok: false, reason: 'stale_timestamp' };
  const tMs = t > 1e12 ? t : t * 1000; // seconds or milliseconds
  if (Math.abs(now.getTime() - tMs) > toleranceSec * 1000) {
    return { ok: false, reason: 'stale_timestamp' };
  }
  return { ok: true };
}

export interface OuraWebhookEvent {
  eventType: string;
  dataType: string;
  objectId: string;
  eventTime: string | null;
  /** Oura's user id (matches provider_connections.external_user_id). */
  ouraUserId: string;
}

/** Parses an already-verified body. Returns null when required fields are missing. */
export function parseOuraWebhookEvent(body: unknown): OuraWebhookEvent | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const eventType = s(b.event_type);
  const dataType = s(b.data_type);
  const ouraUserId = s(b.user_id);
  if (!eventType || !dataType || !ouraUserId) return null;
  return {
    eventType,
    dataType,
    objectId: s(b.object_id) ?? '',
    eventTime: s(b.event_time),
    ouraUserId,
  };
}

/** GET verification: returns the challenge to echo, or null when the token doesn't match. */
export function answerVerification(
  query: { verification_token?: unknown; challenge?: unknown },
  expectedToken: string,
): string | null {
  if (!expectedToken) return null;
  const { verification_token: tok, challenge } = query;
  if (typeof tok !== 'string' || typeof challenge !== 'string' || !challenge) return null;
  return safeEqual(tok, expectedToken) ? challenge : null;
}

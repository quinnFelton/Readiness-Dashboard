import { createHash, timingSafeEqual } from 'node:crypto';
import { StravaAuthError } from '@rd/provider-adapters/strava';
import express, { Router } from 'express';
import type pg from 'pg';
import { getPool } from '../../users/pool';
import type { StravaIngestService } from '../../providers/strava/strava-ingest-service';

// Strava webhook docs (verified 2026-10-04): https://developers.strava.com/docs/webhooks/
//  - GET  validation: ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=… → 200 {"hub.challenge":…}
//  - POST event: { object_type: "activity"|"athlete", object_id, aspect_type: "create"|"update"|"delete",
//                  owner_id, subscription_id, event_time, updates }
//    Deauthorization = object_type "athlete", updates.authorized = "false".
//  - Must answer 200 within 2 s; Strava retries failed deliveries (up to 3 attempts).
//  - There is NO payload signature, and Strava athlete / public activity ids are public. So an event
//    is only ever a HINT (security review H2): every event type is confirmed with Strava using the
//    user's own token before anything is deleted or disconnected —
//      create/update/delete -> re-fetch the activity; rows go only if Strava says it is gone,
//      deauthorization     -> a real 401 on the user's token, not the event's say-so.
//    Beyond that: the subscription_id pin is mandatory in production (fail closed), events for owners
//    we do not know are counted and dropped (no row, no replay), and repeats of the same
//    (owner, object, aspect) inside a short window are collapsed so forged floods cannot burn the
//    app-wide Strava rate limit (PLAN §5.2) with a victim's token.

export interface StravaEvent {
  object_type: string;
  object_id: number;
  aspect_type: string;
  owner_id: number;
  subscription_id?: number;
  event_time?: number;
  updates?: Record<string, unknown>;
}

export interface StravaWebhookDeps {
  pool?: pg.Pool;
  ingest: StravaIngestService;
  verifyToken?: string; // default STRAVA_WEBHOOK_VERIFY_TOKEN
  /** If set, POST events with a different subscription_id are rejected. Default STRAVA_SUBSCRIPTION_ID. */
  subscriptionId?: string;
  /** Refuse POSTs when no subscription id is pinned. Default: NODE_ENV === 'production'. */
  requireSubscriptionPin?: boolean;
  /** Collapse repeats of one (owner, object, aspect) within this many seconds. Default
   *  STRAVA_EVENT_DEDUPE_SEC or 60; 0 disables. */
  dedupeWindowSec?: number;
  /** Max time to hold the response while processing (Strava's limit is 2 s). Default 1500 ms. */
  responseBudgetMs?: number;
}

const digest = (s: string) => createHash('sha256').update(s).digest();
/** Constant-time string compare (hashing equalises lengths so timingSafeEqual cannot throw). */
export const safeEqual = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

const isEvent = (b: unknown): b is StravaEvent => {
  const e = b as Partial<StravaEvent> | null;
  return (
    !!e &&
    typeof e.object_type === 'string' &&
    typeof e.aspect_type === 'string' &&
    typeof e.object_id === 'number' &&
    typeof e.owner_id === 'number'
  );
};

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isInteger(n) && n >= 0 ? n : fallback;
};

/** Config, not a constant (CLAUDE.md rule 9): STRAVA_EVENT_DEDUPE_SEC (default 60, 0 = off). */
export const dedupeWindowSec = (env: NodeJS.ProcessEnv = process.env): number =>
  positiveInt(env.STRAVA_EVENT_DEDUPE_SEC, 60);

/** Config: STRAVA_REPLAY_MAX_ATTEMPTS (default 5). A failing event is retried this many times. */
export const replayMaxAttempts = (env: NodeJS.ProcessEnv = process.env): number => {
  const n = positiveInt(env.STRAVA_REPLAY_MAX_ATTEMPTS, 5);
  return n >= 1 ? n : 5;
};

/**
 * What a receipt stores: ids only. The renamed-activity title etc. that `updates` can carry is
 * dropped; only the deauthorization flag survives, because replay needs it.
 */
function receiptPayload(ev: StravaEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    object_type: ev.object_type,
    object_id: ev.object_id,
    aspect_type: ev.aspect_type,
    owner_id: ev.owner_id,
  };
  if (ev.subscription_id !== undefined) out.subscription_id = ev.subscription_id;
  if (ev.event_time !== undefined) out.event_time = ev.event_time;
  if (ev.object_type === 'athlete' && ev.updates && 'authorized' in ev.updates) {
    out.updates = { authorized: ev.updates.authorized };
  }
  return out;
}

/** Applies one event. Throws on retryable failure (rate limit, network) so the row is marked failed. */
export async function applyStravaEvent(
  ingest: StravaIngestService,
  userId: string,
  ev: StravaEvent,
): Promise<void> {
  if (ev.object_type === 'athlete') {
    const authorized = ev.updates?.authorized;
    // Confirmed against Strava first: a forged event must not disconnect anyone (H2).
    if (authorized === 'false' || authorized === false) await ingest.confirmDeauthorized(userId);
    return;
  }
  if (ev.object_type !== 'activity') return;
  // create / update / delete all re-fetch. `ingestActivity` removes the stored rows only when Strava
  // reports the activity gone, so a forged `delete` for a live activity changes nothing (H2).
  if (['create', 'update', 'delete'].includes(ev.aspect_type)) {
    await ingest.ingestActivity(userId, ev.object_id);
  }
}

/**
 * Records the receipt unless the same (owner, object, aspect) was recorded for this user within the
 * window. A transaction-scoped advisory lock on the key makes the check-then-insert atomic, so two
 * concurrent duplicates cannot both pass. Returns the new row id, or null for a duplicate.
 */
async function recordReceipt(
  pool: pg.Pool,
  userId: string,
  ev: StravaEvent,
  windowSec: number,
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (windowSec > 0) {
      const key = `strava:${ev.owner_id}:${ev.object_type}:${ev.object_id}:${ev.aspect_type}`;
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
      const dup = await client.query(
        `SELECT 1 FROM webhook_events
          WHERE provider = 'strava' AND user_id = $1
            AND received_at > now() - make_interval(secs => $2)
            AND payload_jsonb->>'object_type' = $3 AND payload_jsonb->>'object_id' = $4
            AND payload_jsonb->>'aspect_type' = $5
          LIMIT 1`,
        [userId, windowSec, ev.object_type, String(ev.object_id), ev.aspect_type],
      );
      if ((dup.rowCount ?? 0) > 0) {
        await client.query('COMMIT');
        return null;
      }
    }
    // Receipt is recorded before any work (PLAN §7 webhook_events: audit/replay, ~30d TTL).
    const ins = await client.query<{ id: string }>(
      `INSERT INTO webhook_events (user_id, provider, payload_jsonb, status)
       VALUES ($1, 'strava', $2, 'pending') RETURNING id`,
      [userId, JSON.stringify(receiptPayload(ev))],
    );
    await client.query('COMMIT');
    return (ins.rows[0] as { id: string }).id;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function stravaWebhookRouter(deps: StravaWebhookDeps): Router {
  const pool = () => deps.pool ?? getPool();
  const verifyToken = () => deps.verifyToken ?? process.env.STRAVA_WEBHOOK_VERIFY_TOKEN ?? '';
  const subscriptionId = () => deps.subscriptionId ?? process.env.STRAVA_SUBSCRIPTION_ID ?? '';
  const requirePin = () => deps.requireSubscriptionPin ?? process.env.NODE_ENV === 'production';
  const windowSec = () => deps.dedupeWindowSec ?? dedupeWindowSec();
  const budget = deps.responseBudgetMs ?? 1500;

  const r = Router();
  r.use(express.json());

  // Subscription validation handshake.
  r.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const expected = verifyToken();
    if (
      mode !== 'subscribe' ||
      typeof token !== 'string' ||
      typeof challenge !== 'string' ||
      !expected ||
      !safeEqual(token, expected)
    ) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    res.status(200).json({ 'hub.challenge': challenge });
  });

  r.post('/', async (req, res) => {
    const ev: unknown = req.body;
    if (!isEvent(ev)) {
      res.status(400).json({ error: 'invalid event' });
      return;
    }
    const pin = subscriptionId();
    if (!pin && requirePin()) {
      // Fail closed: until the subscription id is configured (DEPLOY.md step 8) nothing is acted on.
      res.status(503).json({ error: 'webhook not configured' });
      return;
    }
    if (pin && String(ev.subscription_id ?? '') !== pin) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const userId = await deps.ingest.findUserByAthlete(ev.owner_id);
    if (!userId) {
      // Unknown owner (not connected here, or forged): count it, store nothing, start nothing (M4).
      console.info('strava webhook: event for an unknown owner dropped');
      res.status(200).json({ received: true });
      return;
    }
    const eventId = await recordReceipt(pool(), userId, ev, windowSec());
    if (!eventId) {
      res.status(200).json({ received: true });
      return;
    }

    const work = applyStravaEvent(deps.ingest, userId, ev).then(
      () => setStatus(pool(), eventId, 'processed'),
      (err: unknown) => {
        // Name only: errors may wrap payload fragments (CLAUDE.md rule 6).
        console.warn(
          `strava webhook ${eventId} failed: ${err instanceof Error ? err.name : 'error'}`,
        );
        return markFailed(pool(), eventId, err, replayMaxAttempts());
      },
    );
    // Answer inside Strava's 2 s window; if work overruns, the row stays 'pending' and replay
    // (StravaEventReplayer) picks it up if the runtime drops the in-flight promise.
    let timer: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), budget);
      }),
    ]);
    clearTimeout(timer);
    // Tells the Lambda wrapper a row is still pending, so it (and only then) kicks the replay.
    if (!finished) res.setHeader(REPLAY_HINT_HEADER, '1');
    res.status(200).json({ received: true });
  });

  return r;
}

/** Response header set only when an event is still pending after the response budget. */
export const REPLAY_HINT_HEADER = 'x-rd-replay';

async function setStatus(pool: pg.Pool, id: string, status: 'processed'): Promise<void> {
  await pool.query(`UPDATE webhook_events SET status = $2, processed_at = now() WHERE id = $1`, [
    id,
    status,
  ]);
}

/**
 * A failed attempt: bumps `attempts`, and at the cap (STRAVA_REPLAY_MAX_ATTEMPTS) the row becomes
 * 'abandoned', which replay never selects again. A revoked/invalid grant (StravaAuthError) cannot
 * succeed until the user reconnects, so it is abandoned at once. The 30-day TTL then removes it.
 */
async function markFailed(
  pool: pg.Pool,
  id: string,
  err: unknown,
  maxAttempts: number,
): Promise<'failed' | 'abandoned'> {
  const permanent = err instanceof StravaAuthError || err === 'unparseable';
  const { rows } = await pool.query<{ status: 'failed' | 'abandoned' }>(
    `UPDATE webhook_events
        SET attempts = attempts + 1, processed_at = now(),
            status = CASE WHEN $2::boolean OR attempts + 1 >= $3 THEN 'abandoned' ELSE 'failed' END
      WHERE id = $1 RETURNING status`,
    [id, permanent, maxAttempts],
  );
  return rows[0]?.status ?? 'failed';
}

/**
 * Re-runs Strava events that failed (e.g. rate-limited) or stayed pending past `pendingAfterSec`.
 * Safe to call from the scheduled sync job: processing re-fetches current state and upserts
 * idempotently, so replays and duplicates converge on one row. Each failure counts against
 * `maxAttempts`; the event then goes terminal ('abandoned') instead of retrying until the TTL.
 */
export async function replayStravaEvents(
  pool: pg.Pool,
  ingest: StravaIngestService,
  opts: { limit?: number; pendingAfterSec?: number; maxAttempts?: number } = {},
): Promise<number> {
  const maxAttempts = opts.maxAttempts ?? replayMaxAttempts();
  const { rows } = await pool.query<{ id: string; user_id: string; payload_jsonb: unknown }>(
    `SELECT id, user_id, payload_jsonb FROM webhook_events
      WHERE provider = 'strava' AND user_id IS NOT NULL
        AND (status = 'failed'
             OR (status = 'pending' AND received_at < now() - make_interval(secs => $2)))
      ORDER BY received_at LIMIT $1`,
    [opts.limit ?? 25, opts.pendingAfterSec ?? 300],
  );
  let done = 0;
  let abandoned = 0;
  for (const row of rows) {
    if (!isEvent(row.payload_jsonb)) {
      await markFailed(pool, row.id, 'unparseable', maxAttempts);
      abandoned++;
      continue;
    }
    try {
      await applyStravaEvent(ingest, row.user_id, row.payload_jsonb);
      await setStatus(pool, row.id, 'processed');
      done++;
    } catch (err) {
      if ((await markFailed(pool, row.id, err, maxAttempts)) === 'abandoned') abandoned++;
    }
  }
  // Counts only (no ids, no messages): lets the log show that events were given up on.
  if (abandoned > 0) console.warn(`strava replay: ${abandoned} event(s) abandoned`);
  return done;
}

import { createHash, timingSafeEqual } from 'node:crypto';
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
//  - There is NO payload signature. Authenticity of the subscription is established only by the
//    verify_token at GET time; for POSTs we additionally pin `subscription_id` (when configured) and
//    only act on owner_ids that map to a connected local user. Events never carry data — we always
//    re-fetch from Strava with the user's own token — so a forged event cannot inject metrics.

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

/** Applies one event. Throws on retryable failure (rate limit, network) so the row is marked failed. */
export async function applyStravaEvent(
  ingest: StravaIngestService,
  userId: string,
  ev: StravaEvent,
): Promise<void> {
  if (ev.object_type === 'athlete') {
    const authorized = ev.updates?.authorized;
    if (authorized === 'false' || authorized === false) await ingest.markDeauthorized(userId);
    return;
  }
  if (ev.object_type !== 'activity') return;
  if (ev.aspect_type === 'delete') {
    await ingest.removeActivity(userId, ev.object_id);
  } else if (ev.aspect_type === 'create' || ev.aspect_type === 'update') {
    await ingest.ingestActivity(userId, ev.object_id);
  }
}

export function stravaWebhookRouter(deps: StravaWebhookDeps): Router {
  const pool = () => deps.pool ?? getPool();
  const verifyToken = () => deps.verifyToken ?? process.env.STRAVA_WEBHOOK_VERIFY_TOKEN ?? '';
  const subscriptionId = () => deps.subscriptionId ?? process.env.STRAVA_SUBSCRIPTION_ID ?? '';
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
    if (pin && String(ev.subscription_id ?? '') !== pin) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const userId = await deps.ingest.findUserByAthlete(ev.owner_id);
    // Receipt is recorded before any work (PLAN §7 webhook_events: audit/replay, ~30d TTL). The
    // payload is the notification itself (ids only) — no health data.
    const ins = await pool().query<{ id: string }>(
      `INSERT INTO webhook_events (user_id, provider, payload_jsonb, status)
       VALUES ($1, 'strava', $2, $3) RETURNING id`,
      [userId, JSON.stringify(ev), userId ? 'pending' : 'processed'],
    );
    const eventId = (ins.rows[0] as { id: string }).id;

    if (userId) {
      const work = applyStravaEvent(deps.ingest, userId, ev).then(
        () => setStatus(pool(), eventId, 'processed'),
        (err: unknown) => {
          // Name only: errors may wrap payload fragments (CLAUDE.md rule 6).
          console.warn(
            `strava webhook ${eventId} failed: ${err instanceof Error ? err.name : 'error'}`,
          );
          return setStatus(pool(), eventId, 'failed');
        },
      );
      // Answer inside Strava's 2 s window; if work overruns, the row stays 'pending' and replay
      // (StravaEventReplayer) picks it up if the runtime drops the in-flight promise.
      await Promise.race([work, new Promise<void>((resolve) => setTimeout(resolve, budget))]);
    }
    res.status(200).json({ received: true });
  });

  return r;
}

async function setStatus(pool: pg.Pool, id: string, status: 'processed' | 'failed'): Promise<void> {
  await pool.query(`UPDATE webhook_events SET status = $2, processed_at = now() WHERE id = $1`, [
    id,
    status,
  ]);
}

/**
 * Re-runs Strava events that failed (e.g. rate-limited) or stayed pending past `pendingAfterSec`.
 * Safe to call from the scheduled sync job: processing re-fetches current state and upserts
 * idempotently, so replays and duplicates converge on one row.
 */
export async function replayStravaEvents(
  pool: pg.Pool,
  ingest: StravaIngestService,
  opts: { limit?: number; pendingAfterSec?: number } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: string; user_id: string; payload_jsonb: unknown }>(
    `SELECT id, user_id, payload_jsonb FROM webhook_events
      WHERE provider = 'strava' AND user_id IS NOT NULL
        AND (status = 'failed'
             OR (status = 'pending' AND received_at < now() - make_interval(secs => $2)))
      ORDER BY received_at LIMIT $1`,
    [opts.limit ?? 25, opts.pendingAfterSec ?? 300],
  );
  let done = 0;
  for (const row of rows) {
    if (!isEvent(row.payload_jsonb)) {
      await setStatus(pool, row.id, 'failed');
      continue;
    }
    try {
      await applyStravaEvent(ingest, row.user_id, row.payload_jsonb);
      await setStatus(pool, row.id, 'processed');
      done++;
    } catch {
      await setStatus(pool, row.id, 'failed');
    }
  }
  return done;
}

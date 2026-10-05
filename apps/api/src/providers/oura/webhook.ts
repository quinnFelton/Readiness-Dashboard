import { type ConnectionGrant, createAdapterRegistry } from '@rd/provider-adapters';
import express, { type Request, type Response, Router } from 'express';
import type pg from 'pg';
import { type TokenCipher, createTokenCipher } from '../../crypto/token-cipher';
import { type Recompute, sharedRecompute } from '../../fatigue-fitness/recompute';
import { SyncService } from '../../sync/sync-service';
import { getPool } from '../../users/pool';
import { withOuraUserLock } from './lock';
import {
  OURA_COLLECTION_METRICS,
  OuraAdapter,
  type OuraConfig,
  type OuraWebhookEvent,
  answerVerification,
  ouraConfigFromEnv,
  parseOuraWebhookEvent,
  verifyOuraSignature,
} from './register';
import { storeTokens } from './sync-job';

// PLAN §5.1/§14: Oura webhooks (the approach Oura's docs recommend). Protocol per the official spec 1.41
// `webhookDocs` (packages/provider-adapters/src/oura/docs/openapi-excerpt.json,
// https://cloud.ouraring.com/v2/static/json/openapi-1.41.json):
//   GET  ?verification_token&challenge  -> 200 { challenge }  (subscription handshake)
//   POST x-oura-signature / x-oura-timestamp, body {event_type, data_type, object_id, event_time, user_id}
// Events carry no data, only ids, so we re-fetch the affected window through the same adapter path as the
// polling job and upsert idempotently. Polling (sync-job.ts) remains the fallback/backfill.
//
// Mount: app.use('/api/v1/webhooks/oura', createOuraWebhookRouter()). Mount it BEFORE express.json() so the
// exact signed bytes are available; if the body was already parsed we fall back to JSON.stringify(body),
// which is what Oura's reference implementation signs.

const PROVIDER = 'oura';
const DAY_MS = 86_400_000;
const fmtDay = (d: Date) => d.toISOString().slice(0, 10);

export interface OuraWebhookDeps {
  pool: pg.Pool;
  cipher: TokenCipher;
  adapter: OuraAdapter;
  config: OuraConfig;
  now?: () => Date;
  /** Trend/readiness recompute after new data (PLAN §8.4). Default: the process-wide hook. */
  recompute?: Recompute;
}

export type EventOutcome =
  'processed' | 'unknown_user' | 'ignored_data_type' | 'ignored_event_type';

interface ConnRow {
  user_id: string;
  external_user_id: string | null;
  access_token_enc: Buffer | null;
  refresh_token_enc: Buffer | null;
  expires_at: Date | null;
  last_synced_at: Date | null;
}

/** Records receipt metadata only (never tokens, never health values) — PLAN §7/§13, CLAUDE.md rule 5. */
async function recordReceipt(
  pool: pg.Pool,
  userId: string | null,
  meta: Record<string, unknown>,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO webhook_events (user_id, provider, payload_jsonb, status)
     VALUES ($1, $2, $3::jsonb, 'pending') RETURNING id`,
    [userId, PROVIDER, JSON.stringify(meta)],
  );
  return rows[0]!.id;
}

async function finishReceipt(
  pool: pg.Pool,
  id: string,
  status: 'processed' | 'failed',
  outcome: string,
) {
  await pool
    .query(
      `UPDATE webhook_events
          SET status = $2, processed_at = now(), payload_jsonb = payload_jsonb || $3::jsonb
        WHERE id = $1`,
      [id, status, JSON.stringify({ outcome })],
    )
    .catch(() => undefined); // the receipt is an audit log; never fail the delivery on it
}

/**
 * Applies one verified event for a known user. Throws on failure (the router turns that into a 5xx so
 * Oura retries — its docs: 10 retries on 4xx/5xx/timeouts). Exported for tests and reconciliation tools.
 */
export async function processOuraEvent(
  deps: OuraWebhookDeps,
  userId: string,
  event: OuraWebhookEvent,
): Promise<'processed' | 'ignored_data_type' | 'ignored_event_type'> {
  const { config } = deps;
  const collection = config.webhookCollections[event.dataType];
  if (!collection) return 'ignored_data_type';
  if (!config.webhookEventTypes.includes(event.eventType)) return 'ignored_event_type';
  const now = deps.now ?? config.now ?? (() => new Date());

  const locked = await withOuraUserLock(deps.pool, userId, async () => {
    const { rows } = await deps.pool.query<ConnRow>(
      `SELECT user_id, external_user_id, access_token_enc, refresh_token_enc, expires_at, last_synced_at
         FROM provider_connections WHERE user_id = $1 AND provider = $2 AND is_active`,
      [userId, PROVIDER],
    );
    const conn = rows[0];
    if (!conn) throw new Error('NotConnected');
    const ctx = `${userId}:${PROVIDER}`;

    // Window: the payload has no date, only object_id. Re-fetch from webhookLookbackDays before the
    // earlier of event_time and last_synced_at (a ring that synced after days offline delivers old days).
    const t = event.eventTime ? Date.parse(event.eventTime) : Number.NaN;
    const anchor = Number.isFinite(t) ? t : now().getTime();
    const from = Math.min(anchor, conn.last_synced_at?.getTime() ?? anchor);
    const range = {
      startDate: fmtDay(new Date(from - config.webhookLookbackDays * DAY_MS)),
      endDate: fmtDay(new Date(now().getTime() + DAY_MS)),
    };

    let raw: unknown;
    try {
      const result = await deps.adapter.fetchWindow(
        {
          userId,
          accessToken: conn.access_token_enc
            ? await deps.cipher.decrypt(conn.access_token_enc, ctx)
            : undefined,
          refreshToken: conn.refresh_token_enc
            ? await deps.cipher.decrypt(conn.refresh_token_enc, ctx)
            : undefined,
          expiresAt: conn.expires_at,
          externalUserId: conn.external_user_id,
          since: null,
        },
        range,
        [collection],
      );
      if (result.refreshedGrant) await storeTokens(deps, userId, result.refreshedGrant);
      raw = result.raw;
    } catch (err) {
      // Refresh tokens are single-use: persist a refreshed grant even though the fetch failed.
      const grant = (err as { refreshedGrant?: ConnectionGrant } | null)?.refreshedGrant;
      if (grant) await storeTokens(deps, userId, grant).catch(() => undefined);
      throw err;
    }

    const registry = createAdapterRegistry();
    registry.register(deps.adapter);
    const ingested = await new SyncService(deps.pool, registry, deps.cipher, now).ingest(
      userId,
      PROVIDER,
      raw,
    );
    const touched = [...ingested.dates];

    if (event.eventType === 'delete') {
      // The deleted document is simply absent from the re-fetch. Remove oura rows of the metric types this
      // collection feeds, inside the window, that the fresh data no longer produces. Idempotent.
      const keep = deps.adapter.normalize(raw).map((r) => `${r.date}|${r.metricType}`);
      const removed = await deps.pool.query<{ date: string }>(
        `DELETE FROM daily_metrics
          WHERE user_id = $1 AND source = $2 AND metric_type = ANY($3::text[])
            AND date BETWEEN $4::date AND $5::date
            AND (date::text || '|' || metric_type) <> ALL($6::text[])
          RETURNING to_char(date, 'YYYY-MM-DD') AS date`,
        [
          userId,
          PROVIDER,
          OURA_COLLECTION_METRICS[collection],
          range.startDate,
          range.endDate,
          keep,
        ],
      );
      touched.push(...removed.rows.map((r) => r.date));
    }
    return touched;
  });
  if (!locked.acquired) throw new Error('SyncInProgress');
  // PLAN §8.4: compute on sync. After the lock is released; the hook never throws, so a recompute
  // failure leaves the delivery `processed` (no Oura retry storm for a scoring problem).
  await (deps.recompute ?? sharedRecompute())(userId, 'daily_metrics', locked.value);
  return 'processed';
}

/** Raw signed bytes if available, else the docs' JSON.stringify(parsed body) fallback. */
function bodyText(req: Request): string | null {
  const b: unknown = req.body;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (typeof b === 'string') return b;
  if (b && typeof b === 'object' && Object.keys(b).length > 0) return JSON.stringify(b);
  return null;
}

/**
 * Router for /api/v1/webhooks/oura. Dependencies are optional and resolved lazily per request so the
 * router can be mounted at startup without env/DB; tests inject everything.
 */
export function createOuraWebhookRouter(overrides: Partial<OuraWebhookDeps> = {}): Router {
  let cached: OuraWebhookDeps | undefined;
  const deps = (): OuraWebhookDeps => {
    if (overrides.pool && overrides.cipher && overrides.adapter && overrides.config) {
      return overrides as OuraWebhookDeps;
    }
    if (!cached) {
      const config = overrides.config ?? ouraConfigFromEnv();
      cached = {
        pool: overrides.pool ?? getPool(),
        cipher: overrides.cipher ?? createTokenCipher(),
        adapter: overrides.adapter ?? new OuraAdapter(config),
        config,
        now: overrides.now,
        recompute: overrides.recompute,
      };
    }
    return cached;
  };

  const router = Router();

  // Subscription handshake (spec webhookDocs, "Step 3: Verification Process").
  router.get('/', async (req: Request, res: Response) => {
    const d = deps();
    const challenge = answerVerification(
      req.query as { verification_token?: unknown; challenge?: unknown },
      d.config.webhookVerificationToken,
    );
    if (challenge === null) {
      res.status(401).json({ error: 'invalid verification token' });
      return;
    }
    // Only a handshake that proved knowledge of the token is recorded (unauthenticated calls write nothing).
    const id = await recordReceipt(d.pool, null, { kind: 'verification' }).catch(() => null);
    if (id) await finishReceipt(d.pool, id, 'processed', 'verified');
    res.json({ challenge });
  });

  router.post(
    '/',
    express.raw({ type: () => true, limit: '256kb' }),
    async (req: Request, res: Response) => {
      const d = deps();
      const now = (d.now ?? d.config.now ?? (() => new Date()))();
      const text = bodyText(req);

      // 1. Authenticity first — nothing in the body is read before this passes (CLAUDE.md rule 7).
      const check = text
        ? verifyOuraSignature({
            clientSecret: d.config.clientSecret,
            signature: req.get('x-oura-signature'),
            timestamp: req.get('x-oura-timestamp'),
            rawBody: text,
            now,
            toleranceSec: d.config.webhookToleranceSec,
          })
        : { ok: false as const, reason: 'missing_header' as const };
      if (!check.ok) {
        res.status(401).json({ error: check.reason ?? 'unauthorized' });
        return;
      }

      // 2. Parse (now trusted) and resolve the local user.
      let event: OuraWebhookEvent | null = null;
      try {
        event = parseOuraWebhookEvent(JSON.parse(text as string));
      } catch {
        /* falls through to 400 */
      }
      if (!event) {
        res.status(400).json({ error: 'malformed event' });
        return;
      }

      let receiptId: string | null = null;
      try {
        const { rows } = await d.pool.query<{ user_id: string }>(
          `SELECT user_id FROM provider_connections
            WHERE provider = $1 AND external_user_id = $2 AND is_active`,
          [PROVIDER, event.ouraUserId],
        );
        const userId = rows[0]?.user_id ?? null;
        // 3. Receipt: metadata only, never the raw payload beyond these routing fields.
        receiptId = await recordReceipt(d.pool, userId, {
          event_type: event.eventType,
          data_type: event.dataType,
          object_id: event.objectId,
          event_time: event.eventTime,
          oura_user_id: event.ouraUserId,
        });

        let outcome: EventOutcome = 'unknown_user';
        if (userId) outcome = await processOuraEvent(d, userId, event);
        await finishReceipt(d.pool, receiptId, 'processed', outcome);
        res.status(200).json({ ok: true, outcome });
      } catch (err) {
        const name = err instanceof Error ? err.name : 'error';
        const msg = err instanceof Error ? err.message : '';
        if (receiptId) await finishReceipt(d.pool, receiptId, 'failed', name);
        // 5xx => Oura retries (docs: 10 retries). Name only in the body: messages may embed payload bits.
        res.status(msg === 'SyncInProgress' ? 503 : 500).json({ error: name });
      }
    },
  );

  return router;
}

import { type AdapterRegistry, type TerraClient, defaultRegistry } from '@rd/provider-adapters';
import express, { type ErrorRequestHandler, Router } from 'express';
import type pg from 'pg';
import { ConnectionConfigService } from '../../connections/config-service';
import { ConnectionService } from '../../connections/connection-service';
import { type TokenCipher, createTokenCipher } from '../../crypto/token-cipher';
import {
  type BackfillConfig,
  backfillConfigFromEnv,
  runTerraBackfillOnce,
} from '../../providers/terra/backfill';
import { SyncService } from '../../sync/sync-service';
import { getPool } from '../../users/pool';
import { verifyTerraSignature } from './signature';

export interface TerraWebhookDeps {
  pool?: pg.Pool;
  registry?: AdapterRegistry;
  cipher?: TokenCipher;
  /** Terra dashboard signing secret. Defaults to TERRA_SIGNING_SECRET; unset => fail closed (500). */
  signingSecret?: string;
  /** Replay window. Terra documents none, so it's config: TERRA_WEBHOOK_TOLERANCE_SEC (default 300). */
  toleranceSec?: number;
  nowSec?: () => number;
  /** Test seams. */
  ingest?: (userId: string, raw: unknown) => Promise<unknown>;
  saveGrant?: (userId: string, externalUserId: string) => Promise<unknown>;
  backfill?: (userId: string, terraUserId: string) => Promise<unknown>;
  backfillConfig?: BackfillConfig;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = '6mb'; // API Gateway/Lambda sync payload ceiling

type Outcome = 'processed' | 'ignored';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const asObj = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/**
 * POST /api/v1/webhooks/terra (PLAN §6). Auth is the HMAC signature, not a user session.
 *
 * MOUNTING: this router carries its own raw-body parser and MUST be mounted before any global
 * `express.json()` (which would consume the stream and break signature verification). See the
 * "Needs from other phases" note: apps/api/src/app.ts currently installs express.json() first.
 */
export function terraWebhookRouter(deps: TerraWebhookDeps = {}): Router {
  const registry = deps.registry ?? defaultRegistry;
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const pool = () => deps.pool ?? getPool();
  let cipher = deps.cipher;
  const getCipher = () => (cipher ??= createTokenCipher());
  const secret = () => deps.signingSecret ?? process.env.TERRA_SIGNING_SECRET ?? '';
  const tolerance = () =>
    deps.toleranceSec ?? (Number(process.env.TERRA_WEBHOOK_TOLERANCE_SEC) || 300);

  let sync: SyncService | undefined;
  const ingest =
    deps.ingest ??
    ((userId: string, raw: unknown) =>
      (sync ??= new SyncService(pool(), registry, getCipher())).ingest(userId, 'terra', raw));
  const saveGrant =
    deps.saveGrant ??
    ((userId: string, externalUserId: string) =>
      new ConnectionService(
        pool(),
        registry,
        getCipher(),
        new ConnectionConfigService(pool(), registry),
      ).saveGrant(userId, 'terra', 'daily_metrics_source', { externalUserId }));
  const backfill =
    deps.backfill ??
    ((userId: string, terraUserId: string) => {
      const client = (registry.getByProvider('terra') as { client?: TerraClient } | undefined)
        ?.client;
      if (!client) throw new Error('terra adapter not registered');
      return runTerraBackfillOnce(
        pool(),
        client,
        userId,
        terraUserId,
        deps.backfillConfig ?? backfillConfigFromEnv(),
      );
    });

  const r = Router();

  r.post('/', express.raw({ type: () => true, limit: MAX_BODY }), async (req, res) => {
    const key = secret();
    if (!key) {
      // Misconfiguration must never degrade into "accept unsigned".
      res.status(500).json({ error: 'webhook not configured' });
      return;
    }
    const body: unknown = req.body;
    if (body !== undefined && !Buffer.isBuffer(body)) {
      // A JSON parser ran before us: the raw bytes are gone, so verification is impossible.
      res.status(500).json({ error: 'webhook body parser misconfigured' });
      return;
    }
    const rawBody = Buffer.isBuffer(body) ? body : Buffer.alloc(0);

    // 1. Authenticity first — nothing below touches the payload until this passes (rule 7).
    const sig = verifyTerraSignature(
      rawBody,
      req.header('terra-signature'),
      key,
      nowSec(),
      tolerance(),
    );
    if (!sig.ok) {
      res.status(401).json({ error: 'invalid signature' }); // reason deliberately not echoed
      return;
    }

    // 2. Parse (authentic by now).
    let payload: Record<string, unknown> | undefined;
    try {
      payload = asObj(JSON.parse(rawBody.toString('utf8')));
    } catch {
      payload = undefined;
    }
    if (!payload) {
      res.status(400).json({ error: 'invalid payload' });
      return;
    }
    const type = str(payload.type) ?? 'unknown';
    const user = asObj(payload.user);
    const terraUserId = str(user?.user_id);
    const referenceId = str(user?.reference_id) ?? str(payload.reference_id);
    const items = Array.isArray(payload.data) ? payload.data.length : 0;

    // 3. Record receipt. Metadata only: webhook_events is an audit log, raw health payloads are
    //    not retained anywhere (rule 5/6). user_id stays NULL until matched to a local user.
    const meta = {
      type,
      status: str(payload.status) ?? null,
      items,
      terra_user_id: terraUserId ?? null,
    };
    const ev = await pool().query<{ id: string }>(
      `INSERT INTO webhook_events (provider, payload_jsonb, status) VALUES ('terra', $1, 'pending') RETURNING id`,
      [JSON.stringify(meta)],
    );
    const eventId = ev.rows[0]!.id;
    const finish = (status: 'processed' | 'failed', userId: string | null, detail: string) =>
      pool().query(
        `UPDATE webhook_events
            SET status = $2, processed_at = now(), user_id = $3,
                payload_jsonb = payload_jsonb || $4::jsonb
          WHERE id = $1`,
        [eventId, status, userId, JSON.stringify({ result: detail })],
      );

    let userId: string | null = null;
    try {
      const out = await handle();
      await finish('processed', userId, out.detail);
      res.status(200).json({ status: out.outcome });
    } catch {
      // Never log/echo the error: it may embed payload fragments (rule 6). 5xx => Terra retries.
      await finish('failed', userId, 'error').catch(() => undefined);
      res.status(500).json({ error: 'processing failed' });
    }

    async function handle(): Promise<{ outcome: Outcome; detail: string }> {
      const ignored = (detail: string) => ({ outcome: 'ignored' as const, detail });
      if (!referenceId || !UUID_RE.test(referenceId)) return ignored('no_reference_id');

      if (type === 'auth') {
        // Records the Terra user_id against our user (PLAN §5.3) — the reliable twin of the browser
        // redirect, which can be lost. Requires an existing local user for reference_id.
        if (!terraUserId || (str(payload!.status) ?? 'success') !== 'success')
          return ignored('auth_not_success');
        const u = await pool().query(`SELECT 1 FROM users WHERE id = $1`, [referenceId]);
        if (u.rowCount === 0) return ignored('unknown_reference_id');
        userId = referenceId;
        await saveGrant(referenceId, terraUserId);
        await backfill(referenceId, terraUserId);
        return { outcome: 'processed', detail: 'auth' };
      }

      // Everything else must belong to an active terra connection whose Terra user_id matches, so a
      // forged-but-signed or stale payload for someone else's reference_id can't write their data.
      const c = await pool().query(
        `SELECT 1 FROM provider_connections
          WHERE user_id = $1 AND provider = 'terra' AND is_active AND external_user_id = $2`,
        [referenceId, terraUserId ?? null],
      );
      if (c.rowCount === 0) return ignored('unknown_or_inactive_connection');
      userId = referenceId;

      if (type === 'deauth' || type === 'access_revoked') {
        await pool().query(
          `UPDATE provider_connections SET is_active = false
            WHERE user_id = $1 AND provider = 'terra' AND external_user_id = $2`,
          [referenceId, terraUserId],
        );
        return { outcome: 'processed', detail: type };
      }
      if (type === 'sleep' || type === 'daily' || type === 'body') {
        // daily/body flow through normalize too; the adapter decides what maps (currently sleep only).
        await ingest(referenceId, payload);
        return { outcome: 'processed', detail: type };
      }
      // user_reauth, s3_payload (ping mode), etc.: recorded, intentionally not acted on.
      return ignored(`unhandled_type:${type.slice(0, 32)}`);
    }
  });

  const onError: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    // Raw-parser failures (e.g. body too large): generic, no details.
    const status = typeof err?.status === 'number' && err.status < 500 ? err.status : 500;
    res.status(status).json({ error: status === 413 ? 'payload too large' : 'bad request' });
  };
  r.use(onError);

  return r;
}

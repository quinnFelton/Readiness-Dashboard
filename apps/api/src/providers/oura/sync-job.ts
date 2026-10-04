import {
  type AdapterRegistry,
  type ConnectionGrant,
  createAdapterRegistry,
} from '@rd/provider-adapters';
import type pg from 'pg';
import { type TokenCipher, createTokenCipher } from '../../crypto/token-cipher';
import { SyncService } from '../../sync/sync-service';
import type { SyncResult } from '../../sync/sync-service';
import { getPool } from '../../users/pool';
import { OuraAdapter, ouraConfigFromEnv } from './register';

// PLAN §5.1/§13: scheduled (EventBridge) incremental pull. Oura webhooks were NOT adopted (see the
// phase report): their API could not be verified from the docs available, and signature checks must
// not be written from memory (CLAUDE.md rules 7/8). Polling remains the sync model.

const PROVIDER = 'oura';

export interface OuraSyncDeps {
  pool: pg.Pool;
  cipher: TokenCipher;
  adapter: OuraAdapter;
  now?: () => Date;
}

interface ConnRow {
  external_user_id: string | null;
  access_token_enc: Buffer | null;
  refresh_token_enc: Buffer | null;
  expires_at: Date | null;
  last_synced_at: Date | null;
}

/**
 * Incremental, idempotent sync of one user's Oura data. Oura refresh tokens are single-use, so a
 * refreshed grant is persisted even when the data fetch/ingest fails afterwards — otherwise the
 * connection would be permanently lost. A per-user advisory lock stops overlapping runs from
 * spending the same refresh token twice.
 */
export async function syncOuraUser(userId: string, deps: OuraSyncDeps): Promise<SyncResult> {
  const base = { provider: PROVIDER, dailyMetrics: 0, activityEfforts: 0 };
  const now = deps.now ?? (() => new Date());
  const lockClient = await deps.pool.connect();
  let locked = false;
  try {
    const lock = await lockClient.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`,
      [`oura-sync:${userId}`],
    );
    locked = lock.rows[0]?.ok === true;
    if (!locked) return { ...base, ok: false, error: 'SyncInProgress' };

    const { rows } = await deps.pool.query<ConnRow>(
      `SELECT external_user_id, access_token_enc, refresh_token_enc, expires_at, last_synced_at
         FROM provider_connections WHERE user_id = $1 AND provider = $2 AND is_active`,
      [userId, PROVIDER],
    );
    const conn = rows[0];
    if (!conn) return { ...base, ok: false, error: 'NotConnected' };

    const ctx = `${userId}:${PROVIDER}`;
    // Taken before fetching so data landing mid-run is covered by the next run's window.
    const startedAt = now();
    try {
      const result = await deps.adapter.fetchRaw({
        userId,
        accessToken: conn.access_token_enc
          ? await deps.cipher.decrypt(conn.access_token_enc, ctx)
          : undefined,
        refreshToken: conn.refresh_token_enc
          ? await deps.cipher.decrypt(conn.refresh_token_enc, ctx)
          : undefined,
        expiresAt: conn.expires_at,
        externalUserId: conn.external_user_id,
        since: conn.last_synced_at,
      });
      if (result.refreshedGrant) await storeTokens(deps, userId, result.refreshedGrant);
      // Reuses the framework's normalize + idempotent upsert path (stamps userId/source, no raw retained).
      const registry: AdapterRegistry = createAdapterRegistry();
      registry.register(deps.adapter);
      const counts = await new SyncService(deps.pool, registry, deps.cipher, now).ingest(
        userId,
        PROVIDER,
        result.raw,
      );
      await deps.pool.query(
        `UPDATE provider_connections SET last_synced_at = $3 WHERE user_id = $1 AND provider = $2`,
        [userId, PROVIDER, startedAt],
      );
      return { ...base, ...counts, ok: true };
    } catch (err) {
      const grant = (err as { refreshedGrant?: ConnectionGrant } | null)?.refreshedGrant;
      if (grant) await storeTokens(deps, userId, grant).catch(() => undefined);
      // Name only: messages/objects could embed payload fragments (rule 6).
      return { ...base, ok: false, error: err instanceof Error ? err.name : 'sync failed' };
    }
  } finally {
    if (locked) {
      await lockClient
        .query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`oura-sync:${userId}`])
        .catch(() => undefined);
    }
    lockClient.release();
  }
}

async function storeTokens(deps: OuraSyncDeps, userId: string, g: ConnectionGrant) {
  const ctx = `${userId}:${PROVIDER}`;
  await deps.pool.query(
    `UPDATE provider_connections SET
       access_token_enc = COALESCE($3, access_token_enc),
       refresh_token_enc = COALESCE($4, refresh_token_enc),
       expires_at = COALESCE($5, expires_at)
     WHERE user_id = $1 AND provider = $2`,
    [
      userId,
      PROVIDER,
      g.accessToken ? await deps.cipher.encrypt(g.accessToken, ctx) : null,
      g.refreshToken ? await deps.cipher.encrypt(g.refreshToken, ctx) : null,
      g.expiresAt ?? null,
    ],
  );
}

/** Every user with an active Oura connection; failures are isolated per user. */
export async function syncOuraAll(deps: OuraSyncDeps): Promise<Map<string, SyncResult>> {
  const { rows } = await deps.pool.query<{ user_id: string }>(
    `SELECT user_id FROM provider_connections WHERE provider = $1 AND is_active`,
    [PROVIDER],
  );
  const out = new Map<string, SyncResult>();
  for (const r of rows) out.set(r.user_id, await syncOuraUser(r.user_id, deps));
  return out;
}

/**
 * Lambda/EventBridge entrypoint. `{ "userId": "<uuid>" }` syncs one user; an empty event syncs all.
 * Returns counts only (never tokens or payloads).
 */
export async function handler(event: { userId?: string } = {}) {
  const deps: OuraSyncDeps = {
    pool: getPool(),
    cipher: createTokenCipher(),
    adapter: new OuraAdapter(ouraConfigFromEnv()),
  };
  if (event.userId) return { results: { [event.userId]: await syncOuraUser(event.userId, deps) } };
  return { results: Object.fromEntries(await syncOuraAll(deps)) };
}

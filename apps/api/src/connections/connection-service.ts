import type { AdapterRegistry, ConnectionGrant } from '@rd/provider-adapters';
import type { ProviderConnection } from '@rd/shared-types';
import type pg from 'pg';
import type { TokenCipher } from '../crypto/token-cipher';
import type { ConnectionConfigService } from './config-service';
import { loadFatigueFitnessConfig } from '../fatigue-fitness/config';
import { type Recompute, lastDays, sharedRecompute } from '../fatigue-fitness/recompute';
import { HttpError } from './errors';

interface ConnectionRow {
  id: string;
  user_id: string;
  provider: string;
  role: ProviderConnection['role'];
  external_user_id: string | null;
  expires_at: Date | null;
  is_active: boolean;
  last_synced_at: Date | null;
  connected_at: Date;
}

const toConnection = (r: ConnectionRow): ProviderConnection => ({
  id: r.id,
  userId: r.user_id,
  provider: r.provider,
  role: r.role,
  externalUserId: r.external_user_id,
  expiresAt: r.expires_at?.toISOString() ?? null,
  isActive: r.is_active,
  lastSyncedAt: r.last_synced_at?.toISOString() ?? null,
  connectedAt: r.connected_at.toISOString(),
});

// Token columns are deliberately never selected here.
const PUBLIC_COLS = `id, user_id, provider, role, external_user_id, expires_at,
                     is_active, last_synced_at, connected_at`;

/** Connection lifecycle. Provider-agnostic: all provider behaviour is behind the registry. */
export class ConnectionService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: AdapterRegistry,
    private readonly cipher: TokenCipher,
    private readonly configs: ConnectionConfigService,
    /** Trend/readiness rebuild after disconnect (PLAN §8.4). Default: the process-wide hook. */
    private readonly recompute?: Recompute,
  ) {}

  async list(userId: string): Promise<ProviderConnection[]> {
    const { rows } = await this.pool.query<ConnectionRow>(
      `SELECT ${PUBLIC_COLS} FROM provider_connections WHERE user_id = $1 ORDER BY provider`,
      [userId],
    );
    return rows.map(toConnection);
  }

  /** Persists a completed connect flow: encrypted tokens, idempotent on (user_id, provider). */
  async saveGrant(
    userId: string,
    provider: string,
    role: ProviderConnection['role'],
    grant: ConnectionGrant,
  ): Promise<ProviderConnection> {
    const ctx = `${userId}:${provider}`;
    const access = grant.accessToken ? await this.cipher.encrypt(grant.accessToken, ctx) : null;
    const refresh = grant.refreshToken ? await this.cipher.encrypt(grant.refreshToken, ctx) : null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ConnectionRow>(
        `INSERT INTO provider_connections
           (user_id, provider, role, external_user_id, access_token_enc, refresh_token_enc, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, provider) DO UPDATE SET
           role = EXCLUDED.role,
           external_user_id = EXCLUDED.external_user_id,
           access_token_enc = EXCLUDED.access_token_enc,
           refresh_token_enc = EXCLUDED.refresh_token_enc,
           expires_at = EXCLUDED.expires_at,
           is_active = true
         RETURNING ${PUBLIC_COLS}`,
        [
          userId,
          provider,
          role,
          grant.externalUserId ?? null,
          access,
          refresh,
          grant.expiresAt ?? null,
        ],
      );
      await this.configs.ensureConfigured(userId, provider, role, client);
      await client.query('COMMIT');
      return toConnection(rows[0] as ConnectionRow);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Runs the adapter's callback handling for the already-verified user and stores the result. */
  async completeCallback(
    userId: string,
    provider: string,
    query: Record<string, string | undefined>,
  ): Promise<ProviderConnection> {
    const adapter = this.registry.getByProvider(provider);
    if (!adapter) throw new HttpError(404, 'unknown provider');
    const grant = await adapter.handleCallback({ userId, query });
    return this.saveGrant(userId, provider, adapter.role, grant);
  }

  /**
   * Removes the stored tokens and the source selection for this provider, in one transaction.
   *
   * By default the user's history stays (PLAN §10 flow 8): the scalars already derived from this
   * provider, and the trends / readiness built on them, are kept so that switching devices does not
   * reset the long-term picture. Kept rows from a source that is no longer configured rank after
   * the configured ones (`pickBySource`), so a new device takes over wherever it has data.
   *
   * `deleteData: true` is the explicit erase (PLAN §12): it also deletes everything derived from
   * this provider for this user, matching on the `source` column, which SyncService forces to the
   * adapter key on every row it writes.
   */
  async disconnect(
    userId: string,
    provider: string,
    opts: { deleteData?: boolean } = {},
  ): Promise<void> {
    const deleteData = opts.deleteData === true;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (deleteData) {
        await client.query(`DELETE FROM daily_metrics WHERE user_id = $1 AND source = $2`, [
          userId,
          provider,
        ]);
        await client.query(`DELETE FROM activity_efforts WHERE user_id = $1 AND source = $2`, [
          userId,
          provider,
        ]);
      }
      await client.query(`DELETE FROM connection_configs WHERE user_id = $1 AND provider = $2`, [
        userId,
        provider,
      ]);
      await client.query(`DELETE FROM provider_connections WHERE user_id = $1 AND provider = $2`, [
        userId,
        provider,
      ]);
      if (deleteData) {
        // Derived scores/states were built (in part) from the rows just deleted; drop them so the
        // dashboard cannot show numbers from data the user asked us to erase (PLAN §12).
        await client.query(`DELETE FROM trends WHERE user_id = $1`, [userId]);
        await client.query(`DELETE FROM readiness_scores WHERE user_id = $1`, [userId]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    // Rebuild the dashboard window: from whatever remains after an erase, or with the changed
    // source precedence when the history was kept (PLAN §8.4).
    // Best effort: the disconnect already succeeded, and the hook never throws (it logs the error
    // name only; messages may quote health data).
    await (this.recompute ?? sharedRecompute())(
      userId,
      'daily_metrics',
      lastDays(loadFatigueFitnessConfig().longDays),
    );
  }
}

import type { AdapterRegistry, AnyAdapter, ConnectionGrant } from '@rd/provider-adapters';
import type { NormalizedActivityEffort, NormalizedDailyMetric } from '@rd/shared-types';
import { DEFAULT_DERIVER_ID } from '@rd/scoring-engine';
import type pg from 'pg';
import type { TokenCipher } from '../crypto/token-cipher';

// PLAN §6: orchestrates whichever adapters connection_configs says are active. Contains NO
// provider-specific code — everything provider-shaped lives behind ProviderAdapter.

export interface SyncResult {
  provider: string;
  ok: boolean;
  dailyMetrics: number;
  activityEfforts: number;
  /** Safe, non-sensitive failure description (never tokens or payloads). */
  error?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

interface ActiveConnection {
  provider: string;
  role: 'activity_source' | 'daily_metrics_source';
  external_user_id: string | null;
  access_token_enc: Buffer | null;
  refresh_token_enc: Buffer | null;
  expires_at: Date | null;
  last_synced_at: Date | null;
}

export class SyncService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: AdapterRegistry,
    private readonly cipher: TokenCipher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Syncs every configured + connected + active provider for one user. Failures are isolated per provider. */
  async syncUser(userId: string): Promise<SyncResult[]> {
    const { rows } = await this.pool.query<ActiveConnection>(
      `SELECT pc.provider, pc.role, pc.external_user_id, pc.access_token_enc,
              pc.refresh_token_enc, pc.expires_at, pc.last_synced_at
         FROM connection_configs cc
         JOIN provider_connections pc
           ON pc.user_id = cc.user_id AND pc.provider = cc.provider AND pc.role = cc.role
        WHERE cc.user_id = $1 AND pc.is_active
        ORDER BY cc.role, cc.priority, cc.provider`,
      [userId],
    );
    const results: SyncResult[] = [];
    for (const conn of rows) {
      const adapter = this.registry.get(conn.provider, conn.role);
      if (!adapter?.fetchRaw) continue; // unregistered, or push-only (webhook-delivered)
      results.push(await this.syncOne(userId, adapter, conn));
    }
    return results;
  }

  /** One scheduled run: every user that has at least one configured source (PLAN §13: simple loop, no queue). */
  async syncAll(): Promise<Map<string, SyncResult[]>> {
    const { rows } = await this.pool.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM connection_configs`,
    );
    const out = new Map<string, SyncResult[]>();
    for (const r of rows) out.set(r.user_id, await this.syncUser(r.user_id));
    return out;
  }

  /**
   * Normalize + upsert a raw payload for a user. Public so push-based providers (webhook handlers)
   * can reuse the exact same path as pull sync. The raw payload is not retained.
   * `dates` are the distinct days written, so callers can recompute those trend windows (PLAN §8.4).
   */
  async ingest(
    userId: string,
    provider: string,
    raw: unknown,
  ): Promise<{ dailyMetrics: number; activityEfforts: number; dates: string[] }> {
    const adapter = this.registry.getByProvider(provider);
    if (!adapter) throw new Error(`no adapter registered for provider "${provider}"`);
    const dates: string[] = [];
    const counts = await this.normalizeAndUpsert(userId, adapter, raw, dates);
    return { ...counts, dates };
  }

  private async syncOne(
    userId: string,
    adapter: AnyAdapter,
    conn: ActiveConnection,
  ): Promise<SyncResult> {
    const base = { provider: adapter.key, dailyMetrics: 0, activityEfforts: 0 };
    try {
      const ctx = `${userId}:${adapter.key}`;
      const result = await adapter.fetchRaw!({
        userId,
        accessToken: conn.access_token_enc
          ? await this.cipher.decrypt(conn.access_token_enc, ctx)
          : undefined,
        refreshToken: conn.refresh_token_enc
          ? await this.cipher.decrypt(conn.refresh_token_enc, ctx)
          : undefined,
        expiresAt: conn.expires_at,
        externalUserId: conn.external_user_id,
        since: conn.last_synced_at,
      });
      if (result.refreshedGrant)
        await this.storeRefreshedTokens(userId, adapter.key, result.refreshedGrant);
      const counts = await this.normalizeAndUpsert(userId, adapter, result.raw);
      await this.pool.query(
        `UPDATE provider_connections SET last_synced_at = $3 WHERE user_id = $1 AND provider = $2`,
        [userId, adapter.key, this.now()],
      );
      return { ...base, ...counts, ok: true };
    } catch (err) {
      // Message only: errors from adapters could embed payload fragments, so never log the object.
      return { ...base, ok: false, error: err instanceof Error ? err.name : 'sync failed' };
    }
  }

  private async storeRefreshedTokens(userId: string, provider: string, g: ConnectionGrant) {
    const ctx = `${userId}:${provider}`;
    await this.pool.query(
      `UPDATE provider_connections SET
         access_token_enc = COALESCE($3, access_token_enc),
         refresh_token_enc = COALESCE($4, refresh_token_enc),
         expires_at = COALESCE($5, expires_at)
       WHERE user_id = $1 AND provider = $2`,
      [
        userId,
        provider,
        g.accessToken ? await this.cipher.encrypt(g.accessToken, ctx) : null,
        g.refreshToken ? await this.cipher.encrypt(g.refreshToken, ctx) : null,
        g.expiresAt ?? null,
      ],
    );
  }

  private async normalizeAndUpsert(
    userId: string,
    adapter: AnyAdapter,
    raw: unknown,
    /** Out-param: receives the distinct dates of the normalized rows. */
    touchedDates?: string[],
  ) {
    const version = adapter.derivationVersion ?? 1;
    // The adapter may not be trusted to stamp identity: userId and source are forced here, which is
    // also what makes per-provider disconnect deletion exact.
    const rows = (
      adapter.normalize(raw) as (NormalizedDailyMetric | NormalizedActivityEffort)[]
    ).map((r) => ({ ...r, userId, source: adapter.key }));
    touchedDates?.push(...new Set(rows.map((r) => r.date)));
    if (adapter.role === 'daily_metrics_source') {
      return {
        dailyMetrics: await this.upsertDailyMetrics(rows as NormalizedDailyMetric[], version),
        activityEfforts: 0,
      };
    }
    return {
      dailyMetrics: 0,
      activityEfforts: await this.upsertActivityEfforts(
        rows as NormalizedActivityEffort[],
        version,
      ),
    };
  }

  /** Idempotent on (user_id, date, source, metric_type) — PLAN §7/§13. */
  private async upsertDailyMetrics(
    rows: NormalizedDailyMetric[],
    version: number,
  ): Promise<number> {
    const byKey = new Map<string, NormalizedDailyMetric>(); // ON CONFLICT can't touch a row twice per statement
    for (const r of rows) {
      if (!DATE_RE.test(r.date) || !finite(r.value))
        throw new Error('invalid normalized daily metric');
      byKey.set(`${r.userId}|${r.date}|${r.source}|${r.metricType}`, r);
    }
    const rs = [...byKey.values()];
    if (rs.length === 0) return 0;
    await this.pool.query(
      `INSERT INTO daily_metrics (user_id, date, source, metric_type, value, derivation_version)
       SELECT * FROM unnest($1::uuid[], $2::date[], $3::text[], $4::text[], $5::numeric[], $6::smallint[])
       ON CONFLICT (user_id, date, source, metric_type) DO UPDATE SET
         value = EXCLUDED.value, derivation_version = EXCLUDED.derivation_version`,
      [
        rs.map((r) => r.userId),
        rs.map((r) => r.date),
        rs.map((r) => r.source),
        rs.map((r) => r.metricType),
        rs.map((r) => r.value),
        rs.map(() => version),
      ],
    );
    return rs.length;
  }

  /**
   * Idempotent on (user_id, external_activity_id, deriver_id); rows without a deriverId are the
   * default deriver's (PLAN §8.8). ef_* columns are owned by the scoring engine
   * (CLAUDE.md rule 1), so a re-derived row resets them to NULL rather than leaving stale values.
   */
  private async upsertActivityEfforts(
    rows: NormalizedActivityEffort[],
    version: number,
  ): Promise<number> {
    const byKey = new Map<string, NormalizedActivityEffort>();
    for (const r of rows) {
      if (
        !r.externalActivityId ||
        !DATE_RE.test(r.date) ||
        !Number.isInteger(r.durationSec) ||
        !finite(r.avgHr) ||
        [r.avgPower, r.normalizedPower, r.peak20Power, r.peak20AvgHr].some(
          (v) => v !== undefined && !finite(v),
        )
      ) {
        throw new Error('invalid normalized activity effort');
      }
      byKey.set(`${r.userId}|${r.externalActivityId}|${r.deriverId ?? DEFAULT_DERIVER_ID}`, r);
    }
    const rs = [...byKey.values()];
    if (rs.length === 0) return 0;
    const n = (f: (r: NormalizedActivityEffort) => number | undefined) =>
      rs.map((r) => f(r) ?? null);
    await this.pool.query(
      `INSERT INTO activity_efforts
         (user_id, external_activity_id, source, date, duration_sec, avg_power, normalized_power,
          avg_hr, peak20_power, peak20_avg_hr, derivation_version, deriver_id)
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::date[], $5::int[], $6::numeric[],
                            $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[], $11::smallint[],
                            $12::text[])
       ON CONFLICT (user_id, external_activity_id, deriver_id) DO UPDATE SET
         source = EXCLUDED.source, date = EXCLUDED.date, duration_sec = EXCLUDED.duration_sec,
         avg_power = EXCLUDED.avg_power, normalized_power = EXCLUDED.normalized_power,
         avg_hr = EXCLUDED.avg_hr, peak20_power = EXCLUDED.peak20_power,
         peak20_avg_hr = EXCLUDED.peak20_avg_hr, derivation_version = EXCLUDED.derivation_version,
         ef_overall = NULL, ef_peak20 = NULL`,
      [
        rs.map((r) => r.userId),
        rs.map((r) => r.externalActivityId),
        rs.map((r) => r.source),
        rs.map((r) => r.date),
        rs.map((r) => r.durationSec),
        n((r) => r.avgPower),
        n((r) => r.normalizedPower),
        rs.map((r) => r.avgHr),
        n((r) => r.peak20Power),
        n((r) => r.peak20AvgHr),
        rs.map(() => version),
        rs.map((r) => r.deriverId ?? DEFAULT_DERIVER_ID),
      ],
    );
    return rs.length;
  }
}

import type { AdapterRegistry } from '@rd/provider-adapters';
import type { ConnectionConfig, DailyMetricType, ProviderKey } from '@rd/shared-types';
import type pg from 'pg';
import {
  type MetricPrecedence,
  type PrecedenceConfig,
  loadPrecedenceConfig,
  pickBySource,
  resolvePrecedence,
} from './precedence';
import { HttpError } from './errors';

type Queryable = pg.Pool | pg.PoolClient;

// PLAN §6/§7: which adapters are active per user and role.
export class ConnectionConfigService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: AdapterRegistry,
    private readonly precedenceCfg: PrecedenceConfig = loadPrecedenceConfig(),
  ) {}

  async getConfig(userId: string, db: Queryable = this.pool): Promise<ConnectionConfig> {
    const { rows } = await db.query<{ role: string; provider: string }>(
      `SELECT role, provider FROM connection_configs
        WHERE user_id = $1 ORDER BY priority ASC, provider ASC`,
      [userId],
    );
    return {
      activitySource: rows.find((r) => r.role === 'activity_source')?.provider ?? null,
      dailyMetricsSources: rows
        .filter((r) => r.role === 'daily_metrics_source')
        .map((r) => r.provider),
    };
  }

  /** Sets (or with null clears) the single activity source. Replaces any previous one atomically. */
  async setActivitySource(userId: string, provider: ProviderKey | null): Promise<void> {
    if (provider !== null && !this.registry.get(provider, 'activity_source')) {
      throw new HttpError(400, `"${provider}" is not an activity source`);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM connection_configs WHERE user_id = $1 AND role = 'activity_source'`,
        [userId],
      );
      if (provider !== null) {
        await client.query(
          `INSERT INTO connection_configs (user_id, role, provider, priority)
           VALUES ($1, 'activity_source', $2, 0)`,
          [userId, provider],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Replaces the ordered daily-metrics sources; index in `providers` becomes priority (0 = preferred). */
  async setDailyMetricsSources(userId: string, providers: ProviderKey[]): Promise<void> {
    if (new Set(providers).size !== providers.length) {
      throw new HttpError(400, 'duplicate provider in dailyMetricsSources');
    }
    for (const p of providers) {
      if (!this.registry.get(p, 'daily_metrics_source')) {
        throw new HttpError(400, `"${p}" is not a daily-metrics source`);
      }
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM connection_configs WHERE user_id = $1 AND role = 'daily_metrics_source'`,
        [userId],
      );
      for (const [i, p] of providers.entries()) {
        await client.query(
          `INSERT INTO connection_configs (user_id, role, provider, priority)
           VALUES ($1, 'daily_metrics_source', $2, $3)`,
          [userId, p, i],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Called after a successful connect so sync picks the provider up. Never overrides an existing
   * choice: an activity source is only set if none exists; a daily source is appended last.
   */
  async ensureConfigured(
    userId: string,
    provider: ProviderKey,
    role: 'activity_source' | 'daily_metrics_source',
    db: Queryable = this.pool,
  ): Promise<void> {
    if (role === 'activity_source') {
      await db.query(
        `INSERT INTO connection_configs (user_id, role, provider, priority)
         VALUES ($1, 'activity_source', $2, 0) ON CONFLICT DO NOTHING`,
        [userId, provider],
      );
      return;
    }
    await db.query(
      `INSERT INTO connection_configs (user_id, role, provider, priority)
       SELECT $1, 'daily_metrics_source', $2,
              COALESCE((SELECT MAX(priority) + 1 FROM connection_configs
                         WHERE user_id = $1 AND role = 'daily_metrics_source'), 0)
       ON CONFLICT (user_id, role, provider) DO NOTHING`,
      [userId, provider],
    );
  }

  /** Per-metric source order. Oura-preferred default until the user sets their own order. */
  async getPrecedence(userId: string): Promise<MetricPrecedence> {
    const { dailyMetricsSources } = await this.getConfig(userId);
    return resolvePrecedence(dailyMetricsSources, this.precedenceCfg);
  }

  /**
   * Winning daily value per (date, metric) under the user's precedence. Each returned row keeps its
   * `source` so conflicts stay traceable (PLAN §6).
   */
  async getResolvedDailyMetrics(
    userId: string,
    from: string,
    to: string,
  ): Promise<{ date: string; metricType: DailyMetricType; source: string; value: number }[]> {
    const precedence = await this.getPrecedence(userId);
    const { rows } = await this.pool.query<{
      date: string;
      metric_type: DailyMetricType;
      source: string;
      value: string;
    }>(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, metric_type, source, value::text AS value
         FROM daily_metrics WHERE user_id = $1 AND date BETWEEN $2 AND $3
        ORDER BY date`,
      [userId, from, to],
    );
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = `${r.date}|${r.metric_type}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const out: { date: string; metricType: DailyMetricType; source: string; value: number }[] = [];
    for (const g of groups.values()) {
      const first = g[0];
      if (!first) continue;
      const order = precedence[first.metric_type] ?? [];
      const win = pickBySource(
        g.map((r) => ({ ...r, value: Number(r.value) })),
        order,
      );
      if (win) {
        out.push({
          date: win.date,
          metricType: win.metric_type,
          source: win.source,
          value: win.value,
        });
      }
    }
    return out.sort(
      (a, b) => a.date.localeCompare(b.date) || a.metricType.localeCompare(b.metricType),
    );
  }
}

// PLAN §6 / §7 — connection roles, provider connections, per-user source config.
export type ConnectionRole = 'activity_source' | 'daily_metrics_source';

/** Known providers today; `string` keeps future adapters (garmin, whoop, ...) schema-free (PLAN §6). */
export type ProviderKey = 'oura' | 'strava' | 'terra' | (string & {});

/** Public view of a provider_connections row. Token columns are never exposed. */
export interface ProviderConnection {
  id: string;
  userId: string;
  provider: ProviderKey;
  role: ConnectionRole;
  externalUserId: string | null;
  expiresAt: string | null; // ISO 8601
  isActive: boolean;
  lastSyncedAt: string | null; // ISO 8601
  connectedAt: string; // ISO 8601
}

/** A user's source configuration (PLAN §7 connection_configs). */
export interface ConnectionConfig {
  /** Exactly one (or none yet) activity source. */
  activitySource: ProviderKey | null;
  /** Ordered, most preferred first (priority ascending). */
  dailyMetricsSources: ProviderKey[];
}

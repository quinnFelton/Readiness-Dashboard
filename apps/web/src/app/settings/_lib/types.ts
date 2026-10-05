// PLAN §6 contracts consumed by the connections screen.
import type { ConnectionConfig, ConnectionRole, ProviderConnection } from '@rd/shared-types';

export type MetricType = 'hrv' | 'resting_hr' | 'sleep_score' | 'readiness';
export type MetricPrecedence = Record<MetricType, string[]>;

/** One registered adapter, from the API registry (GET /connections/providers — see report). */
export interface RegisteredProvider {
  key: string;
  role: ConnectionRole;
  displayName: string;
  /** 'oauth' → redirectUrl from POST /start; 'widget' → Terra widget URL from POST /start. */
  flow?: 'oauth' | 'widget';
}

/** GET /connections/config response (apps/api/src/connections/routes.ts). */
export interface ConfigResponse {
  config: ConnectionConfig;
  precedence: MetricPrecedence;
  connections: ProviderConnection[];
}

export interface ConnectionsOverview extends ConfigResponse {
  providers: RegisteredProvider[];
}

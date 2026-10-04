import type {
  ConnectionRole,
  NormalizedActivityEffort,
  NormalizedDailyMetric,
} from '@rd/shared-types';
import type { ProviderAdapter } from './types';

// PLAN §6: adapters are looked up by provider key + role, never iterated from a fixed list.
// A provider key maps to exactly one role, mirroring provider_connections UNIQUE (user_id, provider).

export type AnyAdapter =
  ProviderAdapter<NormalizedDailyMetric> | ProviderAdapter<NormalizedActivityEffort>;

export interface AdapterRegistry {
  register(adapter: AnyAdapter): void;
  /** Lookup by provider + role; undefined if unknown or registered under a different role. */
  get(provider: string, role: ConnectionRole): AnyAdapter | undefined;
  /** Lookup by provider alone (used by /connections/:provider routes). */
  getByProvider(provider: string): AnyAdapter | undefined;
  listByRole(role: ConnectionRole): AnyAdapter[];
}

export function createAdapterRegistry(): AdapterRegistry {
  const byProvider = new Map<string, AnyAdapter>();
  return {
    register(adapter) {
      if (byProvider.has(adapter.key)) {
        throw new Error(`adapter already registered for provider "${adapter.key}"`);
      }
      byProvider.set(adapter.key, adapter);
    },
    get(provider, role) {
      const a = byProvider.get(provider);
      return a && a.role === role ? a : undefined;
    },
    getByProvider: (provider) => byProvider.get(provider),
    listByRole: (role) => [...byProvider.values()].filter((a) => a.role === role),
  };
}

/** Process-wide registry that provider phases register into at startup. Tests build their own. */
export const defaultRegistry: AdapterRegistry = createAdapterRegistry();

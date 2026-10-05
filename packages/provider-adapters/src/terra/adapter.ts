import type { NormalizedDailyMetric } from '@rd/shared-types';
import type {
  CallbackContext,
  ConnectionGrant,
  ProviderAdapter,
  StartContext,
  StartResult,
} from '../types';
import { type TerraClient, type TerraClientConfig, createTerraClient } from './client';
import { normalizeTerraPayload } from './normalize';

// PLAN §5.3 / §6. Terra is a push-only daily_metrics_source: no `fetchRaw` (so SyncService never
// polls it); data arrives via POST /webhooks/terra and one-time backfill (see apps/api).

export interface TerraAdapterConfig extends TerraClientConfig {
  /** Widget `providers` value, e.g. "ZEPP". Provider code is not in the fetched docs → config. */
  providers?: string;
  /** Where Terra sends the browser after the widget; `state` is appended so it round-trips. */
  successRedirectUrl: string;
  failureRedirectUrl?: string;
}

export interface TerraAdapter extends ProviderAdapter<NormalizedDailyMetric> {
  readonly client: TerraClient;
}

export function createTerraAdapter(cfg: TerraAdapterConfig): TerraAdapter {
  const client = createTerraClient(cfg);
  return {
    role: 'daily_metrics_source',
    key: 'terra',
    displayName: 'Zepp (via Terra)',
    connectFlow: 'widget',
    // Bump when normalize.ts mapping changes (PLAN §13).
    derivationVersion: 1,
    client,

    normalize: (raw) => normalizeTerraPayload(raw, 'terra'),

    async start({ userId, state }: StartContext): Promise<StartResult> {
      // reference_id = internal user id, so webhooks map back without a lookup table (PLAN §5.3).
      const success = new URL(cfg.successRedirectUrl);
      success.searchParams.set('state', state);
      const { url } = await client.generateWidgetSession({
        referenceId: userId,
        providers: cfg.providers,
        successRedirectUrl: success.toString(),
        failureRedirectUrl: cfg.failureRedirectUrl,
      });
      return { redirectUrl: url };
    },

    /**
     * Success redirect carries user_id, reference_id, resource as query params
     * (https://docs.tryterra.co/unified-api/user-authentication/implementation-terra-widget.md).
     * reference_id must be the already-authenticated user, else someone could bind a foreign
     * Terra account to this user.
     */
    async handleCallback({ userId, query }: CallbackContext): Promise<ConnectionGrant> {
      if (!query.user_id) throw new Error('terra callback: missing user_id');
      if (query.reference_id !== userId) throw new Error('terra callback: reference_id mismatch');
      return { externalUserId: query.user_id };
    },
  };
}

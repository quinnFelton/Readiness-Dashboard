import { deriveActivityEffort } from '@rd/scoring-engine';
import type { NormalizedActivityEffort } from '@rd/shared-types';
import type {
  CallbackContext,
  ConnectionGrant,
  ProviderAdapter,
  StartContext,
  StartResult,
} from '../types';
import { STRAVA_SCOPE, StravaAuthError, type StravaClient } from './client';
import {
  DEFAULT_STRAVA_FILTER,
  type StravaActivityFilter,
  type StravaActivityPayload,
  activityDate,
  skipReason,
  streamsToSamples,
} from './mapping';

export const STRAVA_PROVIDER_KEY = 'strava';

export interface StravaAdapterConfig {
  client: StravaClient;
  filter?: StravaActivityFilter;
}

/**
 * Strava is an *activity source* and webhook-driven (PLAN §5.2), so there is deliberately no
 * `fetchRaw`: SyncService skips push-only adapters, and ingestion runs through the webhook handler
 * + ActivityEffortService (apps/api/src/efforts) which also persists ef_* columns.
 * `normalize` stays pure and reuses the scoring engine so any caller gets identical numbers.
 */
export function createStravaAdapter(
  cfg: StravaAdapterConfig,
): ProviderAdapter<NormalizedActivityEffort> {
  const filter = cfg.filter ?? DEFAULT_STRAVA_FILTER;
  return {
    role: 'activity_source',
    key: STRAVA_PROVIDER_KEY,
    displayName: 'Strava',
    connectFlow: 'oauth',

    normalize(raw: unknown): NormalizedActivityEffort[] {
      const p = raw as Partial<StravaActivityPayload> | null;
      if (!p?.activity || !p.streams) return [];
      if (skipReason(p.activity, filter) !== null) return [];
      const date = activityDate(p.activity);
      if (!date) return [];
      const e = deriveActivityEffort(streamsToSamples(p.streams), {
        minDurationSec: filter.minDurationSec,
      });
      if (!e.qualifies) return [];
      const opt = (n: number | null) => (n === null ? undefined : n);
      return [
        {
          userId: '', // stamped by the caller (SyncService forces userId/source)
          externalActivityId: String(p.activity.id),
          date,
          source: STRAVA_PROVIDER_KEY,
          durationSec: e.durationSec,
          avgPower: e.avgPower,
          normalizedPower: opt(e.normalizedPower),
          avgHr: e.avgHr,
          peak20Power: opt(e.peak20Power),
          peak20AvgHr: opt(e.peak20AvgHr),
        },
      ];
    },

    async start(ctx: StartContext): Promise<StartResult> {
      return { redirectUrl: cfg.client.authorizeUrl(ctx.state) };
    },

    async handleCallback(ctx: CallbackContext): Promise<ConnectionGrant> {
      const { code, error, scope } = ctx.query;
      if (error || !code) throw new StravaAuthError('strava authorization was denied');
      // Users can untick scopes on the consent screen; the redirect then lists only granted ones.
      // https://developers.strava.com/docs/authentication/ (Handling Denied Scopes)
      if (scope !== undefined && !scope.split(/[ ,]/).includes(STRAVA_SCOPE)) {
        throw new StravaAuthError(`strava scope ${STRAVA_SCOPE} was not granted`);
      }
      return cfg.client.exchangeCode(code);
    },
  };
}

import { type AdapterRegistry, defaultRegistry } from '@rd/provider-adapters';
import { StravaClient, StravaRateLimiter, createStravaAdapter } from '@rd/provider-adapters/strava';
import type pg from 'pg';
import { type TokenCipher, createTokenCipher } from '../../crypto/token-cipher';
import {
  ActivityEffortService,
  loadActivityEffortConfig,
} from '../../efforts/activity-effort-service';
import { StravaIngestService } from './strava-ingest-service';

export interface StravaWiring {
  client: StravaClient;
  ingest: StravaIngestService;
  efforts: ActivityEffortService;
}

/**
 * Registers the Strava adapter into the connection framework and builds the services the webhook
 * router needs. Call once at startup (apps/api/src/app.ts — owned by another phase, see report):
 *
 *   const strava = registerStrava(pool);
 *   v1.use('/webhooks/strava', stravaWebhookRouter({ ingest: strava.ingest }));
 */
export function registerStrava(
  pool: pg.Pool,
  opts: {
    registry?: AdapterRegistry;
    cipher?: TokenCipher;
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
  } = {},
): StravaWiring {
  const env = opts.env ?? process.env;
  const cfg = loadActivityEffortConfig(env);
  const client = new StravaClient({
    clientId: env.STRAVA_CLIENT_ID ?? '',
    clientSecret: env.STRAVA_CLIENT_SECRET ?? '',
    redirectUri: env.STRAVA_REDIRECT_URI ?? '',
    fetch: opts.fetch,
    limiter: new StravaRateLimiter({ maxWaitMs: 0 }), // never sleep inside a webhook request
  });
  (opts.registry ?? defaultRegistry).register(createStravaAdapter({ client, filter: cfg.filter }));
  const efforts = new ActivityEffortService(pool, cfg);
  const ingest = new StravaIngestService({
    pool,
    cipher: opts.cipher ?? createTokenCipher(env),
    client,
    efforts,
  });
  return { client, ingest, efforts };
}

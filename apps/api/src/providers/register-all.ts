import {
  type AdapterRegistry,
  StravaClient,
  StravaRateLimiter,
  createStravaAdapter,
  defaultRegistry,
  ouraConfigFromEnv,
} from '@rd/provider-adapters';
import { createTokenCipher } from '../crypto/token-cipher';
import {
  ActivityEffortService,
  loadActivityEffortConfig,
} from '../efforts/activity-effort-service';
import { getPool } from '../users/pool';
import { registerOura } from './oura/register';
import { StravaIngestService } from './strava/strava-ingest-service';
import { registerTerraFromEnv } from './terra/register';

// App-startup wiring for the real provider adapters (PLAN §6: adapters are looked up from a registry,
// never named by shared code). Integration stage C: app.ts calls registerDefaultAdapters() and passes
// lazyStravaIngest() to the Strava webhook router.
//
// Tolerance: a provider whose credentials are absent is simply not registered (its /connections routes
// 404 as "unknown provider"), so tests and local dev boot without real credentials. Registration is
// idempotent, so createApp() may be called many times in one process (tests do).

let stravaClient: StravaClient | undefined;

/** One StravaClient per process, so the adapter and the webhook ingest share one rate limiter. */
function getStravaClient(env: NodeJS.ProcessEnv): StravaClient {
  stravaClient ??= new StravaClient({
    clientId: env.STRAVA_CLIENT_ID ?? '',
    clientSecret: env.STRAVA_CLIENT_SECRET ?? '',
    redirectUri: env.STRAVA_REDIRECT_URI ?? '',
    limiter: new StravaRateLimiter({ maxWaitMs: 0 }), // never sleep inside a webhook request
  });
  return stravaClient;
}

/** Registers every provider whose config is present. Returns the provider keys newly registered. */
export function registerDefaultAdapters(
  registry: AdapterRegistry = defaultRegistry,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const added: string[] = [];

  // Oura (phase 3a): real OAuth needs a client id; sandbox mode needs none (PLAN §5.1).
  if (!registry.getByProvider('oura')) {
    const cfg = ouraConfigFromEnv(env);
    if (cfg.clientId || cfg.sandbox) {
      registerOura(registry, cfg);
      added.push('oura');
    }
  }

  // Terra (phase 3b): its own helper already no-ops without TERRA_DEV_ID/TERRA_API_KEY/redirect URL.
  if (registerTerraFromEnv(registry, env)) added.push('terra');

  // Strava (phase 4): same construction as registerStrava(), minus the eager token cipher (which
  // throws without TOKEN_ENCRYPTION_KEY) — the ingest side is built lazily below.
  if (!registry.getByProvider('strava') && env.STRAVA_CLIENT_ID) {
    registry.register(
      createStravaAdapter({
        client: getStravaClient(env),
        filter: loadActivityEffortConfig(env).filter,
      }),
    );
    added.push('strava');
  }

  return added;
}

/**
 * A StravaIngestService whose dependencies (pool, token cipher, client) are built on first use, so the
 * webhook router can be mounted at startup without DB/env. Mirrors registerStrava() (phase 4).
 */
export function lazyStravaIngest(env: NodeJS.ProcessEnv = process.env): StravaIngestService {
  let inst: StravaIngestService | undefined;
  const get = (): StravaIngestService => {
    if (!inst) {
      const pool = getPool();
      inst = new StravaIngestService({
        pool,
        cipher: createTokenCipher(env),
        client: getStravaClient(env),
        efforts: new ActivityEffortService(pool, loadActivityEffortConfig(env)),
      });
    }
    return inst;
  };
  return new Proxy({} as StravaIngestService, {
    get(_target, prop) {
      const target = get();
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

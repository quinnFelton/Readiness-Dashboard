import { type AdapterRegistry, createTerraAdapter, defaultRegistry } from '@rd/provider-adapters';

/**
 * Registers the Terra adapter from env (TERRA_DEV_ID, TERRA_API_KEY, TERRA_SUCCESS_REDIRECT_URL,
 * optional TERRA_FAILURE_REDIRECT_URL, TERRA_PROVIDERS). No-op if already registered or
 * credentials are absent (so local dev/tests without Terra still boot). Returns whether registered.
 * Call once at app startup (apps/api/src/app.ts), PLAN §6.
 */
export function registerTerraFromEnv(
  registry: AdapterRegistry = defaultRegistry,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (registry.getByProvider('terra')) return false;
  const devId = env.TERRA_DEV_ID;
  const apiKey = env.TERRA_API_KEY;
  const successRedirectUrl = env.TERRA_SUCCESS_REDIRECT_URL;
  if (!devId || !apiKey || !successRedirectUrl) return false;
  registry.register(
    createTerraAdapter({
      devId,
      apiKey,
      successRedirectUrl,
      failureRedirectUrl: env.TERRA_FAILURE_REDIRECT_URL,
      providers: env.TERRA_PROVIDERS,
    }),
  );
  return true;
}

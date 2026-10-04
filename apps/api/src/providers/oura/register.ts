import {
  type AdapterRegistry,
  OuraAdapter,
  type OuraConfig,
  defaultRegistry,
  ouraConfigFromEnv,
} from '@rd/provider-adapters';

export {
  OURA_COLLECTION_METRICS,
  OuraAdapter,
  OuraSubscriptions,
  answerVerification,
  ouraConfigFromEnv,
  ouraSignature,
  parseOuraWebhookEvent,
  verifyOuraSignature,
  type OuraConfig,
  type OuraWebhookEvent,
} from '@rd/provider-adapters';

/** Registers Oura into a registry. App startup calls this; shared code never names the provider. */
export function registerOura(
  registry: AdapterRegistry = defaultRegistry,
  config: OuraConfig = ouraConfigFromEnv(),
): OuraAdapter {
  const adapter = new OuraAdapter(config);
  registry.register(adapter);
  return adapter;
}

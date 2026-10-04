// TEMPORARY relative import: packages/provider-adapters/src/index.ts (phase 2 owned) doesn't re-export
// ./oura yet and the package `exports` only exposes ".". Once it adds `export * from './oura'`, switch
// this to `import { OuraAdapter, ... } from '@rd/provider-adapters'`.
import {
  OuraAdapter,
  type OuraConfig,
  ouraConfigFromEnv,
} from '../../../../../packages/provider-adapters/src/oura';
import { type AdapterRegistry, defaultRegistry } from '@rd/provider-adapters';

export { OuraAdapter, ouraConfigFromEnv, type OuraConfig };

/** Registers Oura into a registry. App startup calls this; shared code never names the provider. */
export function registerOura(
  registry: AdapterRegistry = defaultRegistry,
  config: OuraConfig = ouraConfigFromEnv(),
): OuraAdapter {
  const adapter = new OuraAdapter(config);
  registry.register(adapter);
  return adapter;
}

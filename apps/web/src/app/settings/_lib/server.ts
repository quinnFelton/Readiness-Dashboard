import 'server-only';
import { apiFetch } from '@/lib/auth/api-fetch';
import { FALLBACK_PROVIDERS } from './fixtures';
import type { ConfigResponse, ConnectionsOverview, RegisteredProvider } from './types';

// Server-side typed client; tokens are minted in apiFetch and never reach the browser.

async function loadProviders(): Promise<RegisteredProvider[]> {
  const res = await apiFetch('/connections/providers');
  if (res.status === 404) return FALLBACK_PROVIDERS; // endpoint not built yet (see report)
  if (!res.ok) throw new Error(`providers: ${res.status}`);
  const body = (await res.json()) as { providers: RegisteredProvider[] };
  return body.providers;
}

export async function loadOverview(): Promise<ConnectionsOverview> {
  const [cfgRes, providers] = await Promise.all([apiFetch('/connections/config'), loadProviders()]);
  if (!cfgRes.ok) throw new Error(`config: ${cfgRes.status}`);
  const cfg = (await cfgRes.json()) as ConfigResponse;
  return { ...cfg, providers };
}

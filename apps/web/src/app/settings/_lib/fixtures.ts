import type { RegisteredProvider } from './types';

// Used ONLY when the API has no registry-listing endpoint yet (404). PLAN §6 names these adapters.
export const FALLBACK_PROVIDERS: RegisteredProvider[] = [
  { key: 'strava', role: 'activity_source', displayName: 'Strava', flow: 'oauth' },
  { key: 'oura', role: 'daily_metrics_source', displayName: 'Oura', flow: 'oauth' },
  { key: 'terra', role: 'daily_metrics_source', displayName: 'Zepp (via Terra)', flow: 'widget' },
];

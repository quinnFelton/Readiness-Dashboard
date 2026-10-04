// Recorded-shape fixtures (field names per https://developers.strava.com/docs/reference/).
import type { StravaActivitySummary, StravaStreamSet } from '../mapping';

export const rideSummary = (over: Partial<StravaActivitySummary> = {}): StravaActivitySummary => ({
  id: 9001,
  type: 'Ride',
  sport_type: 'Ride',
  start_date: '2026-03-01T07:00:00Z',
  start_date_local: '2026-03-01T08:00:00Z',
  moving_time: 1800,
  elapsed_time: 1900,
  manual: false,
  has_heartrate: true,
  device_watts: true,
  athlete: { id: 4242 },
  ...over,
});

/** 1 Hz, constant 200 W / 140 bpm → NP = peak20 = 200, EF = 200/140. */
export const steadyStreams = (seconds = 1800, watts = 200, hr = 140): StravaStreamSet => ({
  time: { data: Array.from({ length: seconds }, (_, i) => i) },
  watts: { data: Array.from({ length: seconds }, () => watts) },
  heartrate: { data: Array.from({ length: seconds }, () => hr) },
});

/** Token endpoint response shape. https://developers.strava.com/docs/authentication/ */
export const tokenResponse = (over: Record<string, unknown> = {}) => ({
  token_type: 'Bearer',
  access_token: 'new-access',
  refresh_token: 'new-refresh',
  expires_at: 1_900_000_000,
  expires_in: 21600,
  athlete: { id: 4242 },
  ...over,
});

export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

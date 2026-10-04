import type { StreamSample } from '@rd/scoring-engine';

// Field names verified against https://developers.strava.com/docs/reference/ (DetailedActivity,
// SummaryActivity, StreamSet) on 2026-10-04 — do not rename from memory.

/** Subset of DetailedActivity / SummaryActivity we read. https://developers.strava.com/docs/reference/#api-models-DetailedActivity */
export interface StravaActivitySummary {
  id: number; // https://developers.strava.com/docs/reference/#api-models-SummaryActivity
  type?: string; // deprecated by Strava in favour of sport_type, still returned
  sport_type?: string; // e.g. "Ride", "VirtualRide", "GravelRide", "MountainBikeRide", "Run"
  start_date?: string; // ISO 8601 UTC
  start_date_local?: string; // ISO 8601, wall-clock time at the activity location
  moving_time?: number; // seconds
  elapsed_time?: number; // seconds
  manual?: boolean;
  has_heartrate?: boolean;
  device_watts?: boolean; // true = real power meter (false = Strava-estimated)
  athlete?: { id: number };
}

/**
 * GET /activities/{id}/streams?keys=time,watts,heartrate&key_by_type=true returns an object keyed
 * by stream type, each `{ data: number[], series_type, original_size, resolution }`.
 * https://developers.strava.com/docs/reference/#api-Streams-getActivityStreams
 */
export interface StravaStreamSet {
  time?: { data: number[] };
  watts?: { data: (number | null)[] };
  heartrate?: { data: (number | null)[] };
}

/** Raw payload shape handed to adapter.normalize (one activity). */
export interface StravaActivityPayload {
  activity: StravaActivitySummary;
  streams: StravaStreamSet;
}

/** Thresholds are config (CLAUDE.md rule 9). */
export interface StravaActivityFilter {
  minDurationSec: number;
  /** Strava `sport_type` (falling back to `type`) values treated as rides. */
  rideTypes: readonly string[];
}

// PLAN §5.2: cycling first. E-bike types are excluded on purpose: motor-assisted watts are not
// rider output and would poison the EF trend.
export const DEFAULT_RIDE_TYPES: readonly string[] = [
  'Ride',
  'VirtualRide',
  'GravelRide',
  'MountainBikeRide',
];

export const DEFAULT_STRAVA_FILTER: Readonly<StravaActivityFilter> = Object.freeze({
  minDurationSec: 20 * 60, // overridden by MIN_ACTIVITY_DURATION_SEC
  rideTypes: DEFAULT_RIDE_TYPES,
});

export type SkipReason = 'not_ride' | 'manual' | 'too_short' | 'no_heartrate';

/**
 * Pre-fetch gate, decided from the summary only so we never spend a streams call (PLAN §5.2/§13) on
 * activities that cannot produce a peak-20 window. `moving_time` is the active duration; the engine
 * re-checks on the gap-collapsed stream.
 */
export function skipReason(
  a: StravaActivitySummary,
  filter: StravaActivityFilter = DEFAULT_STRAVA_FILTER,
): SkipReason | null {
  const sport = a.sport_type ?? a.type;
  if (!sport || !filter.rideTypes.includes(sport)) return 'not_ride';
  if (a.manual) return 'manual'; // no streams exist
  if ((a.moving_time ?? a.elapsed_time ?? 0) < filter.minDurationSec) return 'too_short';
  if (a.has_heartrate === false) return 'no_heartrate'; // EF needs HR; saves a call
  return null;
}

/** YYYY-MM-DD of the ride in the athlete's local time (start_date_local), UTC date as fallback. */
export function activityDate(a: StravaActivitySummary): string | null {
  const s = a.start_date_local ?? a.start_date;
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** Zips the parallel `time`/`watts`/`heartrate` arrays into engine samples. Pure. */
export function streamsToSamples(s: StravaStreamSet): StreamSample[] {
  const time = s.time?.data ?? [];
  const watts = s.watts?.data;
  const hr = s.heartrate?.data;
  const out: StreamSample[] = [];
  for (let i = 0; i < time.length; i++) {
    out.push({ t: time[i] as number, watts: watts?.[i] ?? null, hr: hr?.[i] ?? null });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Training load heuristic (PLAN §5.2) — a *relative* effort number per activity; tune freely and
// training_load is not re-derived for old rows (streams are discarded), so a
// formula change only affects activities processed afterwards; record the change date here.
//
// Power-based (when the athlete's FTP is configured and the ride has power):
//     IF  = NP / FTP
//     TSS = durationSec × NP × IF / (FTP × 3600) × 100  =  (durationSec/3600) × IF² × 100
//   (Coggan TSS-equivalent; 1 h at FTP = 100.)
//
// Heart-rate-based fallback (no FTP configured):
//     HRR   = clamp((avgHr − hrRest) / (hrMax − hrRest), 0, 1)
//     TRIMP = durationMin × HRR × 0.64 × e^(1.92 × HRR)        (Banister TRIMP, male coefficients)
//   Roughly: 1 h at HRR 0.75 ≈ 60 × 0.75 × 0.64 × e^1.44 ≈ 122. Not on the TSS scale — hence the
//   `method` tag; never mix methods in one trend without normalising.
// Uses whole-ride avg HR on purpose: training load is about total stress, unlike EF (rule 2) which
// must use the peak-20 window.
// ---------------------------------------------------------------------------------------------

export interface TrainingLoadConfig {
  ftp?: number | null;
  hrMax: number;
  hrRest: number;
}

export const DEFAULT_TRAINING_LOAD_CONFIG: Readonly<TrainingLoadConfig> = Object.freeze({
  ftp: null,
  hrMax: 190,
  hrRest: 60,
});

export type TrainingLoadMethod = 'tss' | 'trimp';

export interface TrainingLoad {
  value: number;
  method: TrainingLoadMethod;
}

export function trainingLoad(
  e: { durationSec: number; avgHr: number; normalizedPower: number | null },
  cfg: TrainingLoadConfig = DEFAULT_TRAINING_LOAD_CONFIG,
): TrainingLoad | null {
  if (!(e.durationSec > 0)) return null;
  if (cfg.ftp && cfg.ftp > 0 && e.normalizedPower !== null && e.normalizedPower > 0) {
    const intensity = e.normalizedPower / cfg.ftp;
    return { value: (e.durationSec / 3600) * intensity * intensity * 100, method: 'tss' };
  }
  if (!(cfg.hrMax > cfg.hrRest) || !(e.avgHr > 0)) return null;
  const hrr = Math.min(1, Math.max(0, (e.avgHr - cfg.hrRest) / (cfg.hrMax - cfg.hrRest)));
  return {
    value: (e.durationSec / 60) * hrr * 0.64 * Math.exp(1.92 * hrr),
    method: 'trimp',
  };
}

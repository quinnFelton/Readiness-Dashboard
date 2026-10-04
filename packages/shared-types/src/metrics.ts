// PLAN §6 — normalized scalars every adapter emits. No raw streams/payloads (CLAUDE.md rule 5).
export type DailyMetricType = 'hrv' | 'resting_hr' | 'sleep_score' | 'readiness';

export interface NormalizedDailyMetric {
  userId: string;
  date: string; // YYYY-MM-DD
  source: 'oura' | 'terra' | (string & {});
  metricType: DailyMetricType;
  value: number;
}

export interface NormalizedActivityEffort {
  userId: string;
  externalActivityId: string; // natural key for idempotent upsert
  date: string; // YYYY-MM-DD
  source: 'strava' | (string & {});
  durationSec: number;
  avgPower?: number;
  normalizedPower?: number; // computed from stream, PLAN §8
  avgHr: number;
  peak20Power?: number; // best rolling 20-min average power
  peak20AvgHr?: number; // HR over that same window, never whole-ride (CLAUDE.md rule 2)
}

import type { NormalizedDailyMetric } from '@rd/shared-types';

// Every field below was verified against the official Oura OpenAPI spec 1.41:
//   https://cloud.ouraring.com/v2/static/json/openapi-1.41.json
// (excerpt committed at ./docs/openapi-excerpt.json). Bump OURA_DERIVATION_VERSION if any mapping changes.
// All mapping is confined to this file.

// v2: sleep periods of type 'deleted' / 'rest' are now excluded (PublicSleepType) and fixtures follow the spec.
export const OURA_DERIVATION_VERSION = 2;

/** Collections we read. Path: GET /v2/usercollection/{collection} (spec 1.41, "Multiple ... Documents"). */
export const OURA_COLLECTIONS = ['daily_readiness', 'daily_sleep', 'sleep'] as const;
export type OuraCollection = (typeof OURA_COLLECTIONS)[number];

/** Combined payload handed from fetchRaw to normalize (discarded after normalize, PLAN §13). */
export interface OuraRawBundle {
  /** MultiDocumentResponse_PublicDailyReadiness_.data -> PublicDailyReadiness {day: ISODate, score: int|null} */
  dailyReadiness: unknown[];
  /** daily_sleep -> PublicDailySleep {day: ISODate, score: int|null} */
  dailySleep: unknown[];
  /** sleep -> PublicModifiedSleepModel {day, type: PublicSleepType|null, average_hrv: int|null,
   *  lowest_heart_rate: int|null, total_sleep_duration: int|null} */
  sleep: unknown[];
}

/** Which daily_metrics a collection feeds (used to reconcile deletions from webhooks). */
export const OURA_COLLECTION_METRICS: Record<
  OuraCollection,
  NormalizedDailyMetric['metricType'][]
> = {
  daily_readiness: ['readiness'],
  daily_sleep: ['sleep_score'],
  sleep: ['hrv', 'resting_hr'],
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

type Metric = NormalizedDailyMetric['metricType'];

export function normalizeOura(raw: unknown): NormalizedDailyMetric[] {
  const b = rec(raw);
  if (!b) return [];
  // Keyed so a repeated (date, metric) keeps exactly one row; later items win, matching upsert semantics.
  const out = new Map<string, NormalizedDailyMetric>();
  const put = (date: unknown, metricType: Metric, value: number | null) => {
    if (typeof date !== 'string' || !DATE_RE.test(date) || value === null) return;
    // userId is stamped by SyncService, never by the adapter.
    out.set(`${date}|${metricType}`, { userId: '', date, source: 'oura', metricType, value });
  };

  for (const item of arr(b.dailyReadiness)) {
    const r = rec(item);
    if (r) put(r.day, 'readiness', num(r.score)); // PublicDailyReadiness.score (integer | null)
  }
  for (const item of arr(b.dailySleep)) {
    const r = rec(item);
    if (r) put(r.day, 'sleep_score', num(r.score)); // PublicDailySleep.score (integer | null)
  }

  // PublicSleepType: deleted | sleep | long_sleep | late_nap | rest. 'deleted' and 'rest' are not real sleep
  // and are ignored. long_sleep (>3h, contributes to daily scores) is the recovery signal; otherwise the
  // longest remaining period wins. HRV = PublicModifiedSleepModel.average_hrv (integer),
  // resting HR = lowest_heart_rate (integer bpm).
  const byDay = new Map<string, Record<string, unknown>>();
  for (const item of arr(b.sleep)) {
    const r = rec(item);
    if (!r || typeof r.day !== 'string') continue;
    if (r.type === 'deleted' || r.type === 'rest') continue;
    const cur = byDay.get(r.day);
    if (!cur || rank(r) > rank(cur)) byDay.set(r.day, r);
  }
  for (const [day, r] of byDay) {
    put(day, 'hrv', num(r.average_hrv));
    put(day, 'resting_hr', num(r.lowest_heart_rate));
  }
  return [...out.values()];
}

/** long_sleep beats everything; ties broken by total_sleep_duration (seconds). */
const rank = (r: Record<string, unknown>) =>
  (r.type === 'long_sleep' ? 1e12 : 0) + (num(r.total_sleep_duration) ?? 0);

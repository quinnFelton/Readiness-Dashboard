import type { NormalizedDailyMetric } from '@rd/shared-types';

// ⚠ FIELD NAMES BELOW ARE UNVERIFIED. The Oura v2 API reference (https://cloud.ouraring.com/v2/docs) is a
// JS app and could not be fetched during the build, so these come from prior knowledge, not the live
// spec. Confirm each against https://cloud.ouraring.com/v2/docs before trusting production data, and
// bump OURA_DERIVATION_VERSION if any mapping changes. All mapping is confined to this file.

export const OURA_DERIVATION_VERSION = 1;

/** Combined payload handed from fetchRaw to normalize (discarded after normalize, PLAN §13). */
export interface OuraRawBundle {
  dailyReadiness: unknown[]; // GET /v2/usercollection/daily_readiness -> items {day, score}
  dailySleep: unknown[]; // GET /v2/usercollection/daily_sleep -> items {day, score}
  sleep: unknown[]; // GET /v2/usercollection/sleep -> items {day, type, average_hrv, lowest_heart_rate, total_sleep_duration}
}

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
    if (r) put(r.day, 'readiness', num(r.score)); // daily_readiness.score (0-100)
  }
  for (const item of arr(b.dailySleep)) {
    const r = rec(item);
    if (r) put(r.day, 'sleep_score', num(r.score)); // daily_sleep.score (0-100)
  }

  // A day can have several sleep periods (naps). The overnight "long_sleep" period is the recovery
  // signal; among candidates take the longest. HRV = average_hrv (ms), resting HR = lowest_heart_rate (bpm).
  const byDay = new Map<string, Record<string, unknown>>();
  for (const item of arr(b.sleep)) {
    const r = rec(item);
    if (!r || typeof r.day !== 'string') continue;
    const cur = byDay.get(r.day);
    if (!cur || rank(r) > rank(cur)) byDay.set(r.day, r);
  }
  for (const [day, r] of byDay) {
    put(day, 'hrv', num(r.average_hrv));
    put(day, 'resting_hr', num(r.lowest_heart_rate));
  }
  return [...out.values()];
}

/** long_sleep beats everything; ties broken by total_sleep_duration. */
const rank = (r: Record<string, unknown>) =>
  (r.type === 'long_sleep' ? 1e12 : 0) + (num(r.total_sleep_duration) ?? 0);

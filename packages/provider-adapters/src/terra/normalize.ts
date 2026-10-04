import type { NormalizedDailyMetric } from '@rd/shared-types';

// Terra webhook payload -> NormalizedDailyMetric rows. Pure, no I/O (PLAN §6).
//
// Doc references (fetched 2026-10-04):
//  - Data models:  https://docs.tryterra.co/reference/health-and-fitness-api/data-models.md
//      Sleep: scores.sleep, heart_rate_data.summary.{resting_hr_bpm, avg_hrv_rmssd, avg_hrv_sdnn},
//             metadata.{start_time, end_time} (ISO-8601). "All fields are nullable". HRV is in ms.
//  - Webhook envelope {status, type, user{user_id, reference_id, provider}, data[]}:
//      https://docs.tryterra.co/unified-api/integration-setup/setting-up-data-destinations/webhooks.md
//      https://docs.tryterra.co/unified-api/user-authentication/authentication-flow.md
//      (the docs pages we could fetch show `user`, `status`, `type` explicitly; `data` as an array
//       follows the Terra data-event convention and PLAN §5.3 — re-verify against a live payload.)
//
// Mapping decisions:
//  - Only `sleep` payloads are mapped. Overnight HRV/resting HR is the recovery signal the
//    dashboard wants (PLAN §1); `daily` payloads are "a running summary of the 24-hour period, sent
//    multiple times" (Terra help centre) and would collide on the same (date, metric) key with
//    sleep-derived rows, making the stored value depend on webhook arrival order. `daily` and `body`
//    are therefore accepted/recorded by the webhook but not mapped (see TERRA_MAPPED_TYPES).
//  - HRV = avg_hrv_rmssd (RMSSD, ms) — same statistic Oura reports — never sdnn, so the two
//    sources stay comparable under the precedence rules (PLAN §6).
//  - Date = local calendar date of metadata.end_time (the wake-up day), matching the "day" a
//    recovery reading is attributed to.
//  - Several sleep sessions on one date (naps): the longest session wins.

export const TERRA_MAPPED_TYPES: ReadonlySet<string> = new Set(['sleep']);

const ISO_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})T/;

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** Terra uses 0/null for "no reading"; all three metrics are strictly positive when real. */
const positive = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

interface Session {
  date: string;
  durationMs: number;
  hrv?: number;
  restingHr?: number;
  sleepScore?: number;
}

function toSession(item: unknown): Session | undefined {
  const o = obj(item);
  if (!o) return undefined;
  const meta = obj(o.metadata);
  const end = typeof meta?.end_time === 'string' ? meta.end_time : undefined;
  const start = typeof meta?.start_time === 'string' ? meta.start_time : undefined;
  const date = end ? ISO_DATE_PREFIX.exec(end)?.[1] : undefined;
  if (!date) return undefined;
  const summary = obj(obj(o.heart_rate_data)?.summary);
  const durationMs = start && end ? Math.max(0, Date.parse(end) - Date.parse(start)) || 0 : 0;
  return {
    date,
    durationMs,
    hrv: positive(summary?.avg_hrv_rmssd),
    restingHr: positive(summary?.resting_hr_bpm),
    sleepScore: positive(obj(o.scores)?.sleep),
  };
}

export function normalizeTerraPayload(raw: unknown, source = 'terra'): NormalizedDailyMetric[] {
  const env = obj(raw);
  if (!env || typeof env.type !== 'string' || !TERRA_MAPPED_TYPES.has(env.type)) return [];
  if (!Array.isArray(env.data)) return [];

  const best = new Map<string, Session>();
  for (const item of env.data) {
    const s = toSession(item);
    if (!s) continue;
    const cur = best.get(s.date);
    if (!cur || s.durationMs > cur.durationMs) best.set(s.date, s);
  }

  // userId is stamped by the API (SyncService.normalizeAndUpsert) — Terra only knows reference_id.
  const out: NormalizedDailyMetric[] = [];
  for (const s of best.values()) {
    const add = (metricType: NormalizedDailyMetric['metricType'], value: number | undefined) => {
      if (value !== undefined) out.push({ userId: '', date: s.date, source, metricType, value });
    };
    add('hrv', s.hrv);
    add('resting_hr', s.restingHr);
    add('sleep_score', s.sleepScore);
  }
  return out;
}

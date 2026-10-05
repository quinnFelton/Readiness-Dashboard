// Pure view-model helpers: turn API rows into what the dashboard renders. No I/O.
import type {
  AthleteEvent,
  InsightFeedback,
  MetricSeries,
  SeriesPoint,
  TrendRow,
  TrendWindow,
} from '@rd/shared-types';
import type { ChartBand, ChartMarker, ChartSeries } from '../charts';
import { dateToTs, tsToDate } from '../charts/chart-data';
import { STATE_META, isStateId } from './state-meta';

const DAY_MS = 86_400_000;

export interface StatePoint {
  asOf: string;
  state: string;
  insightText: string | null;
  classifierId: string;
}

/**
 * One state per as-of date, ascending. The classifier writes state rows per window; the
 * 28d row wins when both exist so a date never shows two states.
 */
export function extractStateHistory(trends: readonly TrendRow[]): StatePoint[] {
  const byDate = new Map<string, TrendRow>();
  for (const t of trends) {
    if (t.metricType !== 'fatigue_fitness_state' || !t.direction) continue;
    const existing = byDate.get(t.asOf);
    if (!existing || (t.window === '28d' && existing.window !== '28d')) byDate.set(t.asOf, t);
  }
  return [...byDate.values()]
    .sort((a, b) => a.asOf.localeCompare(b.asOf))
    .map((t) => ({
      asOf: t.asOf,
      state: t.direction as string,
      insightText: t.insightText,
      classifierId: t.classifierId,
    }));
}

export interface CurrentState extends StatePoint {
  /** First date of the unbroken run of this state ending at the latest point. */
  since: string;
}

export function currentState(history: readonly StatePoint[]): CurrentState | null {
  const last = history[history.length - 1];
  if (!last) return null;
  let since = last.asOf;
  for (let i = history.length - 2; i >= 0; i--) {
    const p = history[i];
    if (!p || p.state !== last.state) break;
    since = p.asOf;
  }
  return { ...last, since };
}

/**
 * Collapse consecutive same-state points into bands. A band runs from its first as-of date
 * to the next different state's date (the last one runs to `endDate`).
 * insufficient_data / unknown states get no band: there's nothing to color.
 */
export function statesToBands(history: readonly StatePoint[], endDate: string): ChartBand[] {
  const runs: { state: string; start: string }[] = [];
  for (const p of history) {
    const last = runs[runs.length - 1];
    if (!last || last.state !== p.state) runs.push({ state: p.state, start: p.asOf });
  }
  const bands: ChartBand[] = [];
  runs.forEach((run, i) => {
    if (!isStateId(run.state) || run.state === 'insufficient_data') return;
    const end = runs[i + 1]?.start ?? endDate;
    const meta = STATE_META[run.state];
    bands.push({
      start: run.start,
      end: end < run.start ? run.start : end,
      color: meta.color,
      label: meta.label,
    });
  });
  return bands;
}

/** Mean of points in the `days`-day window ending (inclusively) at `asOf`. */
export function windowStats(
  points: readonly SeriesPoint[],
  asOf: string,
  days: number,
): { mean: number | null; count: number } {
  const end = dateToTs(asOf);
  const start = end - (days - 1) * DAY_MS;
  let sum = 0;
  let count = 0;
  for (const p of points) {
    const ts = dateToTs(p.date);
    if (ts >= start && ts <= end) {
      sum += p.value;
      count++;
    }
  }
  return { mean: count === 0 ? null : sum / count, count };
}

/** Latest as-of date present anywhere in the data; used as the "today" for window stats. */
export function latestDate(series: MetricSeries, history: readonly StatePoint[]): string | null {
  const dates = [...series.efPeak20, ...series.efOverall, ...series.hrv, ...series.restingHr].map(
    (p) => p.date,
  );
  for (const h of history) dates.push(h.asOf);
  if (dates.length === 0) return null;
  return dates.reduce((a, b) => (a > b ? a : b));
}

export function hasAnyData(series: MetricSeries, history: readonly StatePoint[]): boolean {
  return latestDate(series, history) !== null;
}

// Palette: distinct hues, legible on white and slate-900.
export const METRIC_COLORS = {
  efPeak20: '#2563eb',
  efOverall: '#0891b2',
  hrv: '#16a34a',
  restingHr: '#e11d48',
  readiness: '#7c3aed',
} as const;

/**
 * Hero chart (PLAN §9): EF peak-20 against HRV and resting HR on one timeline. EF is sparse
 * (maxGapDays 1 → dots only across rest days); recovery metrics are daily.
 */
export function heroSeries(series: MetricSeries): ChartSeries[] {
  return [
    {
      key: 'efPeak20',
      label: 'EF peak-20',
      unit: 'W/bpm',
      color: METRIC_COLORS.efPeak20,
      axis: 'ef',
      points: series.efPeak20,
      showDots: true,
    },
    {
      key: 'hrv',
      label: 'HRV',
      unit: 'ms',
      color: METRIC_COLORS.hrv,
      axis: 'hrv',
      points: series.hrv,
    },
    {
      key: 'restingHr',
      label: 'Resting HR',
      unit: 'bpm',
      color: METRIC_COLORS.restingHr,
      axis: 'rhr',
      points: series.restingHr,
    },
  ];
}

export const EVENT_LABEL: Record<AthleteEvent['eventType'], string> = {
  illness: 'Illness',
  injury: 'Injury',
  race: 'Race',
  planned_rest: 'Planned rest',
};

const EVENT_COLOR: Record<AthleteEvent['eventType'], string> = {
  illness: '#ea580c',
  injury: '#be123c',
  race: '#0369a1',
  planned_rest: '#475569',
};

/** Markers show only the type, never notes (health-adjacent free text). */
export function eventMarkers(events: readonly AthleteEvent[], from: string): ChartMarker[] {
  return events
    .filter((e) => e.date >= from)
    .map((e) => ({
      date: e.date,
      label: EVENT_LABEL[e.eventType],
      color: EVENT_COLOR[e.eventType],
    }));
}

/** Current vote for one insight, by this viewer. Falls back to any vote if voter ids are absent. */
export function findVote(
  feedback: readonly InsightFeedback[],
  classifierId: string,
  asOf: string,
  viewerId: string,
): InsightFeedback | null {
  return (
    feedback.find(
      (f) => f.classifierId === classifierId && f.asOf === asOf && f.votedBy === viewerId,
    ) ?? null
  );
}

export function rangeStart(endDate: string, days: number): string {
  return tsToDate(dateToTs(endDate) - (days - 1) * DAY_MS);
}

export interface WindowSummary {
  window: TrendWindow;
  mean: number | null;
  count: number;
  zScore: number | null;
  direction: string | null;
}

/** Per-metric 7d vs 28d context: local means from the series + the server's z-score rows. */
export function summarizeMetric(
  points: readonly SeriesPoint[],
  trends: readonly TrendRow[],
  metricType: TrendRow['metricType'],
  asOf: string,
): WindowSummary[] {
  return (['7d', '28d'] as const).map((window) => {
    const { mean, count } = windowStats(points, asOf, window === '7d' ? 7 : 28);
    const row = trends
      .filter((t) => t.metricType === metricType && t.window === window)
      .sort((a, b) => b.asOf.localeCompare(a.asOf))[0];
    return { window, mean, count, zScore: row?.zScore ?? null, direction: row?.direction ?? null };
  });
}

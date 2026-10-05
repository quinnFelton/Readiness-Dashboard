// Pure data shaping for TimeSeriesChart. No React, so it is trivially testable.
// PLAN §8.1: EF is sparse by design: a rest day has no point and we must NOT interpolate.

export interface ChartPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  kind?: 'line' | 'area';
  /** Axis id; the first two distinct ids get visible left/right axes, the rest are hidden. */
  axis?: string;
  unit?: string;
  points: ChartPoint[];
  /**
   * Connect two consecutive points only if they are at most this many days apart.
   * Default 1 (adjacent days). Larger gaps break the line, so rest days stay empty.
   */
  maxGapDays?: number;
  /** Dots are always drawn for isolated points; set false to hide dots on dense daily series. */
  showDots?: boolean;
}

export interface ChartBand {
  start: string;
  end: string;
  color: string;
  label: string;
}

export interface ChartMarker {
  date: string;
  label: string;
  color: string;
}

export type ChartRow = { ts: number } & Record<string, number | null>;

const DAY_MS = 86_400_000;

/** YYYY-MM-DD → UTC midnight ms. Throws on malformed input so bad data fails loudly. */
export function dateToTs(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) throw new RangeError(`invalid date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function tsToDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Merge series onto one numeric timeline. Each series only has values on its own dates.
 * Where two consecutive points of a series are further apart than `maxGapDays`, a null
 * row is inserted the day after the earlier point so the line breaks instead of
 * interpolating across the gap.
 */
export function buildChartRows(series: readonly ChartSeries[]): ChartRow[] {
  const rows = new Map<number, ChartRow>();
  const row = (ts: number): ChartRow => {
    let r = rows.get(ts);
    if (!r) {
      r = { ts };
      rows.set(ts, r);
    }
    return r;
  };

  for (const s of series) {
    const sorted = [...s.points]
      .map((p) => ({ ts: dateToTs(p.date), value: p.value }))
      .filter((p) => Number.isFinite(p.value))
      .sort((a, b) => a.ts - b.ts);
    const maxGap = (s.maxGapDays ?? 1) * DAY_MS;
    let prev: number | null = null;
    for (const p of sorted) {
      if (prev !== null && p.ts - prev > maxGap) {
        const breakTs = prev + DAY_MS;
        const r = row(breakTs);
        if (r[s.key] === undefined) r[s.key] = null;
      }
      row(p.ts)[s.key] = p.value;
      prev = p.ts;
    }
  }
  return [...rows.values()].sort((a, b) => a.ts - b.ts);
}

/** Series with a single point (or only isolated points) need dots or they would be invisible. */
export function needsDots(s: ChartSeries): boolean {
  if (s.showDots !== undefined) return s.showDots;
  return s.points.length < 15 || (s.maxGapDays ?? 1) > 1;
}

export function timeDomain(
  rows: readonly ChartRow[],
  bands: readonly ChartBand[] = [],
  markers: readonly ChartMarker[] = [],
): [number, number] | null {
  const all: number[] = rows.map((r) => r.ts);
  for (const b of bands) all.push(dateToTs(b.start), dateToTs(b.end));
  for (const m of markers) all.push(dateToTs(m.date));
  if (all.length === 0) return null;
  return [Math.min(...all), Math.max(...all)];
}

export interface AxisSpec {
  id: string;
  orientation: 'left' | 'right';
  hide: boolean;
  label: string;
}

/** First distinct axis → left, second → right (both visible), any further ones hidden. */
export function resolveAxes(series: readonly ChartSeries[]): AxisSpec[] {
  const axes: AxisSpec[] = [];
  for (const s of series) {
    const id = s.axis ?? 'left';
    if (axes.some((a) => a.id === id)) continue;
    const idx = axes.length;
    axes.push({
      id,
      orientation: idx === 1 ? 'right' : 'left',
      hide: idx > 1,
      label: s.unit ? `${s.label} (${s.unit})` : s.label,
    });
  }
  return axes;
}

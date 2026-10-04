/** Deterministic date/series helpers for baseline and classifier tests. */
import type { SeriesPoint } from '../baseline';

/** Add `days` to a YYYY-MM-DD date (UTC calendar arithmetic, pure). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** One point per day for `days` days ending at `asOf`; valueFor(age), where age 0 = asOf. */
export function dailySeries(
  asOf: string,
  days: number,
  valueFor: (age: number) => number,
): SeriesPoint[] {
  const pts: SeriesPoint[] = [];
  for (let age = days - 1; age >= 0; age--) {
    pts.push({ date: addDays(asOf, -age), value: valueFor(age) });
  }
  return pts;
}

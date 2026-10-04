/**
 * Generic rolling baseline (PLAN §8.2): one function reused for ef_peak20, ef_overall,
 * resting_hr and hrv.
 *
 * - A series is a list of points, **not** one value per day. Several points on one date
 *   (multiple rides, PLAN §8.4) each count separately. Days with no point (rest days) are
 *   simply absent; nothing is interpolated (PLAN §8.1 "EF is sparse by design").
 * - Windows are calendar days ending at `asOf`, inclusive. With shortDays = 7 the short
 *   window is asOf-6 … asOf. Points dated after `asOf` are ignored. There is no clock
 *   read: `asOf` is always passed in.
 * - By default the long (28 d) window *includes* the short window (literal PLAN §8.2).
 *   Set `longExcludesShort` to compare against the `longDays` immediately *before* the
 *   short window instead.
 * - z = (shortMean − longMean) / longStdDev, using the **sample** (n − 1) std dev.
 */

export interface SeriesPoint {
  /** Calendar date, `YYYY-MM-DD`, in the user's local day (the caller decides the zone). */
  date: string;
  value: number;
}

export interface BaselineWindows {
  shortDays: number;
  longDays: number;
  /** Default false: the long window includes the short window. */
  longExcludesShort?: boolean;
}

export const DEFAULT_BASELINE_WINDOWS: Readonly<BaselineWindows> = Object.freeze({
  shortDays: 7,
  longDays: 28,
});

export interface BaselineResult {
  asOf: string;
  shortMean: number | null;
  shortCount: number;
  longMean: number | null;
  /** Sample std dev; null with fewer than 2 long-window points. */
  longStdDev: number | null;
  longCount: number;
  /** null when not computable (no short points, < 2 long points, or degenerate std dev). */
  z: number | null;
}

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Relative tolerance for treating a std dev as 0 (identical values plus float noise). */
const DEGENERATE_REL_TOL = 1e-9;

/**
 * Parse a strict `YYYY-MM-DD` calendar date to an integer day number (days since
 * 1970-01-01). Pure: Date.UTC does arithmetic only, with no clock read. Throws on
 * malformed or impossible dates (e.g. 2026-02-30).
 */
export function dayNumber(date: string): number {
  const m = DATE_RE.exec(date);
  if (m === null) throw new RangeError(`invalid date "${date}", expected YYYY-MM-DD`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  // Date.UTC rolls an out-of-range day or month (00, 2-digit overflow) into a neighbouring
  // month, and maps years 0–99 to 1900–1999. So the date is valid iff year and month survive.
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1) {
    throw new RangeError(`invalid date "${date}"`);
  }
  return ms / DAY_MS;
}

function mean(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function sampleStdDev(xs: readonly number[], m: number): number {
  let ss = 0;
  for (const x of xs) ss += (x - m) ** 2;
  return Math.sqrt(ss / (xs.length - 1));
}

export function rollingBaseline(
  series: readonly SeriesPoint[],
  windows: BaselineWindows,
  asOf: string,
): BaselineResult {
  const { shortDays, longDays } = windows;
  const exclude = windows.longExcludesShort === true;
  if (!Number.isInteger(shortDays) || shortDays < 1) {
    throw new RangeError('shortDays must be a positive integer');
  }
  if (!Number.isInteger(longDays) || longDays < 2) {
    throw new RangeError('longDays must be an integer >= 2');
  }
  if (!exclude && longDays < shortDays) {
    throw new RangeError('longDays must be >= shortDays when the long window includes it');
  }

  const asOfDay = dayNumber(asOf);
  const short: number[] = [];
  const long: number[] = [];
  for (const p of series) {
    const age = asOfDay - dayNumber(p.date); // validate every date, even skipped ones
    if (!Number.isFinite(p.value) || age < 0) continue;
    if (age < shortDays) short.push(p.value);
    const inLong = exclude ? age >= shortDays && age < shortDays + longDays : age < longDays;
    if (inLong) long.push(p.value);
  }

  const shortMean = short.length > 0 ? mean(short) : null;
  const longMean = long.length > 0 ? mean(long) : null;
  const longStdDev = longMean !== null && long.length >= 2 ? sampleStdDev(long, longMean) : null;

  let z: number | null = null;
  if (shortMean !== null && longMean !== null && longStdDev !== null) {
    const tol = DEGENERATE_REL_TOL * Math.max(1, Math.abs(longMean));
    if (longStdDev > tol) {
      z = (shortMean - longMean) / longStdDev;
    } else if (Math.abs(shortMean - longMean) <= tol) {
      // A perfectly flat baseline that the short window matches: "no change", not "unknown".
      z = 0;
    }
    // Otherwise there's a real difference with zero spread: z would be ±∞, so leave it null.
  }

  return {
    asOf,
    shortMean,
    shortCount: short.length,
    longMean,
    longStdDev,
    longCount: long.length,
    z,
  };
}

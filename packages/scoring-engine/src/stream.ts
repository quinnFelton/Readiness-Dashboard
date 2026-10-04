/**
 * Stream normalisation for PLAN §8.1.
 *
 * Every power/HR computation in this package runs on a **1 Hz grid of "active" seconds**
 * produced by {@link resampleTo1Hz}. Decisions (documented in README.md):
 *
 * - **Zero-order hold, time-weighted.** Sample `i` holds its values over
 *   `[t_i, t_{i+1})`. Each 1 s grid bucket is the time-weighted mean of the holds that
 *   overlap it. This handles 1 Hz, sub-1 Hz ("smart recording", e.g. 1 sample / 5 s) and
 *   faster-than-1 Hz streams with one rule.
 * - **Gaps longer than `maxGapSec` are collapsed**, not zero-filled: the sample before the
 *   gap holds for a nominal 1 s and the clock resumes at the next sample. A recording gap
 *   (auto-pause, dropout) has neither power nor HR, so dropping it keeps power and HR
 *   averaged over the same seconds. Grid index → original `t` is kept in `t[]`.
 * - **Missing/invalid watts** (`null`, `undefined`, NaN, negative) count as 0 W for power
 *   math but are excluded from `powerCoverage`. A recorded `0` is valid (coasting).
 * - **Missing/invalid HR** (`null`, `undefined`, NaN, ≤ 0) is excluded: buckets with no
 *   valid HR get `null`, and HR averages run over HR-present seconds only.
 * - The last sample holds for a nominal 1 s. Samples with a non-finite `t` are dropped.
 *   Input order doesn't matter (we sort a copy). With duplicate timestamps the later
 *   sample wins (the earlier one holds for 0 s).
 */

export interface StreamSample {
  /** Seconds from any fixed origin (only differences matter). */
  t: number;
  watts?: number | null;
  hr?: number | null;
}

export const DEFAULT_MAX_GAP_SEC = 10;
/** How long the last sample, and the sample before a collapsed gap, are held. */
export const NOMINAL_HOLD_SEC = 1;
const EPS = 1e-6;

export interface ResampledStream {
  /** Watts for each active second. Seconds with no valid power reading are 0. */
  watts: number[];
  /** HR (bpm) for each active second, or null where no valid HR covered it. */
  hr: (number | null)[];
  /** Original stream time `t` at the start of each active second. */
  t: number[];
  /** Fraction of active time covered by a valid power reading (0–1). */
  powerCoverage: number;
  /** Fraction of active time covered by a valid HR reading (0–1). */
  hrCoverage: number;
  /** Total active (gap-collapsed) duration in seconds; may be fractional. */
  durationSec: number;
}

export function isValidWatts(w: number | null | undefined): w is number {
  return typeof w === 'number' && Number.isFinite(w) && w >= 0;
}

export function isValidHr(h: number | null | undefined): h is number {
  return typeof h === 'number' && Number.isFinite(h) && h > 0;
}

export function resampleTo1Hz(
  stream: readonly StreamSample[],
  maxGapSec: number = DEFAULT_MAX_GAP_SEC,
): ResampledStream {
  if (!Number.isFinite(maxGapSec) || maxGapSec < NOMINAL_HOLD_SEC) {
    throw new RangeError(`maxGapSec must be a finite number >= ${NOMINAL_HOLD_SEC}`);
  }
  // filter() returns a fresh array, so sorting it doesn't mutate the caller's input.
  const samples = stream.filter((s) => Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
  const n = samples.length;
  if (n === 0) {
    return { watts: [], hr: [], t: [], powerCoverage: 0, hrCoverage: 0, durationSec: 0 };
  }

  const holds: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const next = samples[i + 1];
    const dt = next === undefined ? NOMINAL_HOLD_SEC : next.t - samples[i]!.t;
    const hold = dt <= maxGapSec ? dt : NOMINAL_HOLD_SEC;
    holds.push(hold);
    total += hold;
  }

  // EPS absorbs float accumulation (e.g. 0.1 s steps summing to 3600.0000000001).
  const size = Math.ceil(total - EPS);
  const wSum = new Array<number>(size).fill(0);
  const wTime = new Array<number>(size).fill(0);
  const hSum = new Array<number>(size).fill(0);
  const hTime = new Array<number>(size).fill(0);
  const start = new Array<number>(size).fill(Number.NaN);
  let powerTime = 0;
  let hrTime = 0;

  let a = 0; // active-time start of the current sample's hold
  for (let i = 0; i < n; i++) {
    const s = samples[i]!;
    const hold = holds[i]!;
    const b = a + hold;
    const w = isValidWatts(s.watts) ? s.watts : null;
    const h = isValidHr(s.hr) ? s.hr : null;
    // A zero-length hold (duplicate timestamp) contributes zero overlap, i.e. no weight.
    for (let k = Math.floor(a); k < b; k++) {
      // Float drift can push the final edge a hair past the last bucket; fold it back in.
      const idx = Math.min(k, size - 1);
      const overlap = Math.min(b, k + 1) - Math.max(a, k);
      if (Number.isNaN(start[idx]!)) start[idx] = s.t + Math.max(0, k - a);
      if (w !== null) {
        wSum[idx]! += w * overlap;
        wTime[idx]! += overlap;
      }
      if (h !== null) {
        hSum[idx]! += h * overlap;
        hTime[idx]! += overlap;
      }
    }
    if (w !== null) powerTime += hold;
    if (h !== null) hrTime += hold;
    a = b;
  }

  return {
    watts: wSum.map((sum, k) => (wTime[k]! > 0 ? sum / wTime[k]! : 0)),
    hr: hSum.map((sum, k) => (hTime[k]! > 0 ? sum / hTime[k]! : null)),
    t: start,
    powerCoverage: powerTime / total,
    hrCoverage: hrTime / total,
    durationSec: total,
  };
}

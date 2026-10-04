/**
 * Power metrics on the 1 Hz active grid (PLAN §8.1). See stream.ts for resampling rules.
 */
import { resampleTo1Hz, type ResampledStream, type StreamSample } from './stream';

/** Standard Coggan NP smoothing window. A formula constant, not a tunable threshold. */
export const NP_ROLLING_WINDOW_SEC = 30;
/** "peak20" = best 20-minute window (PLAN §8.1). */
export const PEAK20_WINDOW_SEC = 20 * 60;

export interface StreamOptions {
  /** Gaps longer than this are collapsed. Default {@link DEFAULT_MAX_GAP_SEC}. */
  maxGapSec?: number;
}

function prefixSums(values: readonly number[]): number[] {
  const p = [0];
  for (let i = 0; i < values.length; i++) p.push(p[i]! + values[i]!);
  return p;
}

/**
 * NP: 30 s rolling average of watts → 4th power → mean → 4th root (PLAN §8.1).
 * Only full 30 s windows are used (the first rolling value lands on second 30), the usual
 * convention. Returns null when there are fewer than 30 active seconds.
 */
export function normalizedPowerFromGrid(watts: readonly number[]): number | null {
  if (watts.length < NP_ROLLING_WINDOW_SEC) return null;
  const p = prefixSums(watts);
  let sum4 = 0;
  let count = 0;
  for (let end = NP_ROLLING_WINDOW_SEC; end <= watts.length; end++) {
    const avg = (p[end]! - p[end - NP_ROLLING_WINDOW_SEC]!) / NP_ROLLING_WINDOW_SEC;
    sum4 += avg ** 4;
    count++;
  }
  return (sum4 / count) ** 0.25;
}

export function normalizedPower(
  stream: readonly StreamSample[],
  opts: StreamOptions = {},
): number | null {
  return normalizedPowerFromGrid(resampleTo1Hz(stream, opts.maxGapSec).watts);
}

export interface PeakWindow {
  /** Mean watts over the window. */
  avgPower: number;
  /** Mean HR over the *same* window (HR-present seconds only), or null if none. */
  avgHr: number | null;
  /** Fraction of window seconds that had valid HR (0–1). */
  hrCoverage: number;
  /** Grid index of the first second in the window (inclusive). */
  startIndex: number;
  /** Grid index one past the last second in the window (exclusive). */
  endIndex: number;
  /** Original stream `t` at the window start. */
  startT: number;
  /** Original stream `t` at the window end (start of last second + 1). */
  endT: number;
}

/**
 * Best `seconds`-long window by mean power, found with an O(n) prefix-sum scan. Ties go to
 * the earliest window. HR is averaged over exactly the same grid seconds as power
 * (CLAUDE.md rule 2: never whole-ride HR). Returns null if the grid is shorter than the window.
 */
export function peakWindowFromGrid(grid: ResampledStream, seconds: number): PeakWindow | null {
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new RangeError('peak window length must be a positive integer number of seconds');
  }
  const n = grid.watts.length;
  if (n < seconds) return null;

  const p = prefixSums(grid.watts);
  let bestStart = 0;
  let bestSum = -Infinity;
  for (let s = 0; s + seconds <= n; s++) {
    const sum = p[s + seconds]! - p[s]!;
    if (sum > bestSum) {
      bestSum = sum;
      bestStart = s;
    }
  }
  const endIndex = bestStart + seconds;

  // HR over the identical window. One O(window) pass, so the whole thing stays O(n).
  let hrSum = 0;
  let hrCount = 0;
  for (let k = bestStart; k < endIndex; k++) {
    const h = grid.hr[k];
    if (h != null) {
      hrSum += h;
      hrCount++;
    }
  }

  return {
    avgPower: bestSum / seconds,
    avgHr: hrCount > 0 ? hrSum / hrCount : null,
    hrCoverage: hrCount / seconds,
    startIndex: bestStart,
    endIndex,
    startT: grid.t[bestStart]!,
    endT: grid.t[endIndex - 1]! + 1,
  };
}

export function peakWindow(
  stream: readonly StreamSample[],
  seconds: number,
  opts: StreamOptions = {},
): PeakWindow | null {
  return peakWindowFromGrid(resampleTo1Hz(stream, opts.maxGapSec), seconds);
}

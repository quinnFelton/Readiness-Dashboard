/**
 * Per-activity derivation, stream → scalars (PLAN §8.1). The output maps 1:1 onto an
 * `activity_efforts` row (PLAN §7). The caller discards the stream afterwards (PLAN §13).
 */
import { PEAK20_WINDOW_SEC, normalizedPowerFromGrid, peakWindowFromGrid } from './power';
import { DEFAULT_MAX_GAP_SEC, resampleTo1Hz, type StreamSample } from './stream';
import { DERIVATION_VERSION } from './version';

/** Thresholds are config, not constants (CLAUDE.md rule 9). */
export interface EffortOptions {
  /** Minimum active duration for a qualifying activity. PLAN §8.1: ≥ 20 min. */
  minDurationSec: number;
  /** Gaps longer than this are collapsed (see stream.ts). */
  maxGapSec: number;
  /** Minimum fraction of active time with a valid power reading. */
  minPowerCoverage: number;
  /**
   * Minimum fraction of active time with valid HR, applied to both the whole ride and the
   * peak20 window. If only the window falls short, peak20 HR/EF are null.
   */
  minHrCoverage: number;
}

export const DEFAULT_EFFORT_OPTIONS: Readonly<EffortOptions> = Object.freeze({
  minDurationSec: 20 * 60,
  maxGapSec: DEFAULT_MAX_GAP_SEC,
  minPowerCoverage: 0.9,
  minHrCoverage: 0.9,
});

export type EffortRejectReason =
  'empty_stream' | 'too_short' | 'insufficient_power' | 'insufficient_hr';

interface EffortCommon {
  /** Active (gap-collapsed) duration, rounded to whole seconds. */
  durationSec: number;
  powerCoverage: number;
  hrCoverage: number;
  derivationVersion: number;
}

export interface QualifyingEffort extends EffortCommon {
  qualifies: true;
  avgPower: number;
  avgHr: number;
  /** Null only if active time < 30 s (possible only with a tiny minDurationSec). */
  normalizedPower: number | null;
  /** Null only if active time < 20 min (possible only with minDurationSec < 1200). */
  peak20Power: number | null;
  /** HR over the exact peak20 window, or null if that window's HR coverage < minHrCoverage. */
  peak20AvgHr: number | null;
  peak20StartT: number | null;
  peak20EndT: number | null;
  /** NP / avg HR, in watts per beat-per-minute. */
  efOverall: number | null;
  /** peak20 power / peak20 HR. The primary signal (PLAN §8.1). */
  efPeak20: number | null;
}

export interface RejectedEffort extends EffortCommon {
  qualifies: false;
  reason: EffortRejectReason;
}

export type ActivityEffort = QualifyingEffort | RejectedEffort;

function assertFraction(name: string, v: number): void {
  if (!(v >= 0 && v <= 1)) throw new RangeError(`${name} must be within [0, 1]`);
}

export function resolveEffortOptions(opts: Partial<EffortOptions> = {}): EffortOptions {
  const o: EffortOptions = { ...DEFAULT_EFFORT_OPTIONS, ...opts };
  if (!(o.minDurationSec >= 0) || !Number.isFinite(o.minDurationSec)) {
    throw new RangeError('minDurationSec must be a finite number >= 0');
  }
  assertFraction('minPowerCoverage', o.minPowerCoverage);
  assertFraction('minHrCoverage', o.minHrCoverage);
  return o;
}

export function deriveActivityEffort(
  stream: readonly StreamSample[],
  opts: Partial<EffortOptions> = {},
): ActivityEffort {
  const o = resolveEffortOptions(opts);
  const grid = resampleTo1Hz(stream, o.maxGapSec);
  const common: EffortCommon = {
    durationSec: Math.round(grid.durationSec),
    powerCoverage: grid.powerCoverage,
    hrCoverage: grid.hrCoverage,
    derivationVersion: DERIVATION_VERSION,
  };
  const reject = (reason: EffortRejectReason): RejectedEffort => ({
    ...common,
    qualifies: false,
    reason,
  });

  if (grid.watts.length === 0) return reject('empty_stream');
  if (common.durationSec < o.minDurationSec) return reject('too_short');
  // "> 0" stops a minimum of 0 from admitting a ride with no power or HR at all.
  if (!(grid.powerCoverage > 0 && grid.powerCoverage >= o.minPowerCoverage)) {
    return reject('insufficient_power');
  }
  if (!(grid.hrCoverage > 0 && grid.hrCoverage >= o.minHrCoverage)) {
    return reject('insufficient_hr');
  }

  // avg_power: plain mean over active seconds (missing power = 0 W, see stream.ts).
  let wSum = 0;
  for (const w of grid.watts) wSum += w;
  const avgPower = wSum / grid.watts.length;

  // avg_hr: mean over HR-present seconds. hrCoverage > 0 guarantees at least one.
  let hSum = 0;
  let hCount = 0;
  for (const h of grid.hr) {
    if (h !== null) {
      hSum += h;
      hCount++;
    }
  }
  const avgHr = hSum / hCount;

  const np = normalizedPowerFromGrid(grid.watts);
  const peak = peakWindowFromGrid(grid, PEAK20_WINDOW_SEC);
  const peakHr =
    peak !== null && peak.avgHr !== null && peak.hrCoverage >= o.minHrCoverage ? peak.avgHr : null;

  return {
    ...common,
    qualifies: true,
    avgPower,
    avgHr,
    normalizedPower: np,
    peak20Power: peak?.avgPower ?? null,
    peak20AvgHr: peakHr,
    peak20StartT: peak?.startT ?? null,
    peak20EndT: peak?.endT ?? null,
    efOverall: np === null ? null : np / avgHr,
    efPeak20: peak !== null && peakHr !== null ? peak.avgPower / peakHr : null,
  };
}

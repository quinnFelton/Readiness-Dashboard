// Pure scoring functions (PLAN §8): NP, peak-20, EF, baselines, quadrant classifier.
// No AWS, DB, network, or Date.now() — inputs in, numbers out (CLAUDE.md rule 1).
// Formulas, sampling assumptions and config defaults: see ../README.md.
export { DERIVATION_VERSION } from './version';

export {
  DEFAULT_MAX_GAP_SEC,
  NOMINAL_HOLD_SEC,
  isValidHr,
  isValidWatts,
  resampleTo1Hz,
  type ResampledStream,
  type StreamSample,
} from './stream';

export {
  NP_ROLLING_WINDOW_SEC,
  PEAK20_WINDOW_SEC,
  normalizedPower,
  normalizedPowerFromGrid,
  peakWindow,
  peakWindowFromGrid,
  type PeakWindow,
  type StreamOptions,
} from './power';

export {
  DEFAULT_EFFORT_OPTIONS,
  deriveActivityEffort,
  resolveEffortOptions,
  type ActivityEffort,
  type EffortOptions,
  type EffortRejectReason,
  type QualifyingEffort,
  type RejectedEffort,
} from './effort';

export {
  DEFAULT_BASELINE_WINDOWS,
  dayNumber,
  rollingBaseline,
  type BaselineResult,
  type BaselineWindows,
  type SeriesPoint,
} from './baseline';

export {
  DEFAULT_CLASSIFIER_CONFIG,
  classifyFatigueFitness,
  directionFromZ,
  formatZ,
  recoveryTrend,
  validateClassifierConfig,
  type Classification,
  type ClassifierConfig,
  type FatigueFitnessState,
  type RecoveryTrend,
  type TrendDirection,
} from './classifier';

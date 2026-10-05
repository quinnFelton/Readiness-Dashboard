// The pure backtest lives in @rd/scoring-engine (packages/scoring-engine/src/backtest.ts); this
// module re-exports it for the comparison routes. (Integration stage D replaced the by-path import.)
export {
  EMPTY_BACKTEST,
  backtestFlags,
  sumBacktests,
  validateBacktestConfig,
  type BacktestConfig,
  type BacktestEvent,
  type BacktestFlag,
  type BacktestOptions,
  type BacktestResult,
} from '@rd/scoring-engine';

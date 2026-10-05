// The pure backtest lives in @rd/scoring-engine (packages/scoring-engine/src/backtest.ts). Phase 5b may
// not edit that package's index.ts, so it is imported by path until the engine's owner adds
// `export * from './backtest'` there.
// TODO(integrator): replace this file's re-export with `from '@rd/scoring-engine'` once exported.
export * from '../../../../packages/scoring-engine/src/backtest';

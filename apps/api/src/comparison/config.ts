import type { BacktestConfig } from './backtest';

// Rule 9: thresholds are config. Env vars with defaults.
//   COMPARISON_LEAD_DAYS            days a warning may precede (or an event may follow) a flag; default 7
//   COMPARISON_FLAG_STATES          csv of states that count as a warning; default overreaching_risk,acute_fatigue
//   COMPARISON_EVENT_TYPES          csv of athlete_events types the backtest counts; default illness,injury
const csv = (raw: string | undefined, fallback: string[]): string[] => {
  const v = raw
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return v?.length ? v : fallback;
};

export function loadComparisonConfig(env: NodeJS.ProcessEnv = process.env): BacktestConfig {
  const raw = env.COMPARISON_LEAD_DAYS;
  const leadDays = raw === undefined || raw.trim() === '' ? 7 : Number(raw);
  if (!Number.isInteger(leadDays) || leadDays < 1) {
    throw new RangeError('COMPARISON_LEAD_DAYS must be an integer >= 1');
  }
  return {
    leadDays,
    flagStates: csv(env.COMPARISON_FLAG_STATES, ['overreaching_risk', 'acute_fatigue']),
    eventTypes: csv(env.COMPARISON_EVENT_TYPES, ['illness', 'injury']),
  };
}

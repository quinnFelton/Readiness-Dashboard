// Admin UI contracts. Roster: PLAN §6 (GET /users) + §13 (latest state per user).
// Comparison: pipeline/phases/5b.md (GET /comparison/classifiers, /comparison/derivers).
// Fields the API doesn't serve yet are optional so the UI degrades to "—" rather than breaking.

export type FatigueFitnessState =
  'fitness_gain' | 'overreaching_risk' | 'acute_fatigue' | 'ambiguous' | (string & {});

export interface RosterConnection {
  provider: string;
  role: 'activity_source' | 'daily_metrics_source';
  lastSyncAt?: string | null;
}

export interface RosterRow {
  id: string;
  name: string | null;
  email: string;
  connections: RosterConnection[];
  latestState: FatigueFitnessState | null;
  latestStateAsOf: string | null;
  lastSyncAt: string | null;
}

export interface ClassifierComparisonRow {
  id: string;
  description?: string | null;
  isDefault: boolean;
  votesUp: number;
  votesDown: number;
  agreementRate: number | null; // 0..1
  backtest: { hits: number; misses: number; falseAlarms: number };
}

export interface DeriverRow {
  id: string;
  description?: string | null;
  isDefault: boolean;
}

export const RANGES = ['30d', '90d', '180d', '365d'] as const;
export type Range = (typeof RANGES)[number];
export function parseRange(v: string | undefined): Range {
  return (RANGES as readonly string[]).includes(v ?? '') ? (v as Range) : '90d';
}

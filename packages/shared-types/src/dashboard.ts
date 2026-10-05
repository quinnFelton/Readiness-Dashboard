// Read-side contract for the dashboard (PLAN §6 /scores and /trends, §7 trends/readiness_scores,
// §8.7 insight_feedback + athlete_events, pipeline/phases/5b.md). The web app codes against these
// shapes; if phase 5b's routes differ, adapt in apps/web/src/components/dashboard/api.ts only.

/** Mirrors FatigueFitnessState in @rd/scoring-engine (kept as a literal union so web needs no engine dependency). */
export type FatigueFitnessStateId =
  | 'fitness_gain'
  | 'overreaching_risk'
  | 'acute_fatigue'
  | 'ambiguous'
  | 'steady'
  | 'insufficient_data';

export type TrendWindow = '7d' | '28d';

export type TrendMetricType =
  'hrv' | 'resting_hr' | 'ef_overall' | 'ef_peak20' | 'fatigue_fitness_state';

export interface TrendRow {
  metricType: TrendMetricType;
  window: TrendWindow;
  classifierId: string;
  asOf: string; // YYYY-MM-DD, the trend's date
  zScore: number | null;
  /** For metricType 'fatigue_fitness_state' this holds the FatigueFitnessStateId. */
  direction: string | null;
  insightText: string | null;
  flaggedAt: string; // ISO 8601
}

/** One observation. EF series are sparse (no row on rest days, PLAN §8.1): never interpolate. */
export interface SeriesPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

export interface MetricSeries {
  efPeak20: SeriesPoint[];
  efOverall: SeriesPoint[];
  hrv: SeriesPoint[];
  restingHr: SeriesPoint[];
}

/** GET /trends/:userId?range= — precomputed rows for the default classifier plus the series they came from. */
export interface TrendsResponse {
  classifierId: string;
  trends: TrendRow[];
  series: MetricSeries;
}

export interface ReadinessScorePoint {
  date: string;
  score: number;
  components: Record<string, number>;
}

/** GET /scores/:userId?range=28d */
export interface ScoresResponse {
  scores: ReadinessScorePoint[];
}

export type InsightVote = 1 | -1;

export interface InsightFeedback {
  classifierId: string;
  asOf: string;
  state: string;
  vote: InsightVote;
  comment: string | null;
  votedBy: string;
}

/** GET /feedback/:userId?range= */
export interface FeedbackResponse {
  feedback: InsightFeedback[];
}

/** PUT /feedback/:userId body */
export interface PutFeedbackBody {
  classifierId: string;
  asOf: string;
  vote: InsightVote;
  comment?: string;
}

export type AthleteEventType = 'illness' | 'injury' | 'race' | 'planned_rest';

export const ATHLETE_EVENT_TYPES: readonly AthleteEventType[] = [
  'illness',
  'injury',
  'race',
  'planned_rest',
];

export interface AthleteEvent {
  id: string;
  date: string; // YYYY-MM-DD
  eventType: AthleteEventType;
  notes: string | null;
}

/** GET /athlete-events/:userId */
export interface AthleteEventsResponse {
  events: AthleteEvent[];
}

/** POST /athlete-events/:userId body */
export interface PostAthleteEventBody {
  date: string;
  eventType: AthleteEventType;
  notes?: string;
}

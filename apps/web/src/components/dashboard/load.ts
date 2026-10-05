import 'server-only';
// Shared loading logic for AthleteDashboard and AthleteTrends. The core payload (trends) must
// succeed; feedback/events degrade gracefully so a missing optional feature never blanks the page.
import type {
  AthleteEvent,
  InsightFeedback,
  ScoresResponse,
  TrendsResponse,
} from '@rd/shared-types';
import { ApiError, getEvents, getFeedback, getScores, getTrends } from './api';

export interface DashboardData {
  trends: TrendsResponse;
  scores: ScoresResponse['scores'];
  feedback: InsightFeedback[];
  feedbackFailed: boolean;
  events: AthleteEvent[];
  eventsFailed: boolean;
}

export type LoadResult = { ok: true; data: DashboardData } | { ok: false; message: string };

export function describeError(e: unknown): string {
  if (e instanceof ApiError && (e.status === 401 || e.status === 403))
    return 'You do not have access to this athlete’s data.';
  if (e instanceof ApiError && e.status === 404) return 'We could not find that athlete.';
  return 'We could not load this data. Please try again.';
}

export interface LoadOptions {
  /** Master drill-down only (PLAN §8.7): which classifier's rows to load; null/undefined = default. */
  classifier?: string | null;
}

export async function loadDashboardData(
  userId: string,
  opts: LoadOptions = {},
): Promise<LoadResult> {
  const [trends, scores, feedback, events] = await Promise.allSettled([
    getTrends(userId, undefined, opts.classifier),
    getScores(userId, undefined, opts.classifier),
    getFeedback(userId),
    getEvents(userId),
  ]);
  if (trends.status === 'rejected') return { ok: false, message: describeError(trends.reason) };
  return {
    ok: true,
    data: {
      trends: trends.value,
      // readiness is secondary (PLAN §8.6): its failure just hides that card
      scores: scores.status === 'fulfilled' ? scores.value.scores : [],
      feedback: feedback.status === 'fulfilled' ? feedback.value.feedback : [],
      feedbackFailed: feedback.status === 'rejected',
      events: events.status === 'fulfilled' ? events.value.events : [],
      eventsFailed: events.status === 'rejected',
    },
  };
}

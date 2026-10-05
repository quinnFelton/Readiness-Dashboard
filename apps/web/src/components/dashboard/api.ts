import 'server-only';
// Small typed REST client for the dashboard (PLAN §6, pipeline/phases/5b.md). Runs only on the
// server: the bearer token is minted in apiFetch and never reaches a client bundle.
import type {
  AthleteEvent,
  AthleteEventsResponse,
  FeedbackResponse,
  PostAthleteEventBody,
  PutFeedbackBody,
  ScoresResponse,
  TrendsResponse,
} from '@rd/shared-types';
import { apiFetch } from '../../lib/auth/api-fetch';
import {
  EMPTY_TRENDS,
  FIXTURE_EVENTS,
  FIXTURE_FEEDBACK,
  FIXTURE_SCORES,
  FIXTURE_TRENDS,
} from './fixtures';

/** Carries only status + path, never a response body (may hold health data). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`API ${status} for ${path}`);
    this.name = 'ApiError';
  }
}

// Dev aid until phase 5b's routes are merged: DASHBOARD_MOCK=1 serves typed fixtures;
// DASHBOARD_MOCK=empty serves a brand-new user's empty state.
const mock = () => process.env.DASHBOARD_MOCK;

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new ApiError(res.status, path);
  return (await res.json()) as T;
}

async function send(path: string, method: string, body?: unknown): Promise<Response> {
  const res = await apiFetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, path);
  return res;
}

const uid = (userId: string) => encodeURIComponent(userId);

/** `?range=…[&classifier=…]`. The classifier is only sent when chosen (master drill-down, §8.7). */
const query = (range: string, classifier?: string | null) =>
  `?range=${encodeURIComponent(range)}` +
  (classifier ? `&classifier=${encodeURIComponent(classifier)}` : '');

const EMPTY_SERIES = (): TrendsResponse['series'] => ({
  efPeak20: [],
  efOverall: [],
  hrv: [],
  restingHr: [],
});

// Integration stage D: the real 5b route (apps/api/src/trends/routes.ts) returns
// `{ userId, classifierId, range, trends }` with the classifier at the top level and no `series`.
// Normalize here (the place dashboard.ts designates for contract drift) so the components keep
// coding against TrendsResponse: copy classifierId onto each row, and default `series` to empty
// until the API serves raw metric series (see docs/reports/integration-D.md).
type RawTrends = {
  classifierId: string;
  trends: Array<Omit<TrendsResponse['trends'][number], 'classifierId'> & { classifierId?: string }>;
  series?: Partial<TrendsResponse['series']>;
};
export function normalizeTrends(raw: RawTrends): TrendsResponse {
  return {
    classifierId: raw.classifierId,
    trends: (raw.trends ?? []).map((t) => ({
      ...t,
      classifierId: t.classifierId ?? raw.classifierId,
    })),
    series: { ...EMPTY_SERIES(), ...(raw.series ?? {}) },
  };
}

export async function getTrends(
  userId: string,
  range = '90d',
  classifier?: string | null,
): Promise<TrendsResponse> {
  if (mock()) return mock() === 'empty' ? EMPTY_TRENDS : FIXTURE_TRENDS;
  return normalizeTrends(
    await getJson<RawTrends>(`/trends/${uid(userId)}${query(range, classifier)}`),
  );
}

export async function getScores(
  userId: string,
  range = '28d',
  classifier?: string | null,
): Promise<ScoresResponse> {
  if (mock()) return mock() === 'empty' ? { scores: [] } : FIXTURE_SCORES;
  return getJson(`/scores/${uid(userId)}${query(range, classifier)}`);
}

// The real 5b route returns `{ userId, range, votes }`; older fixtures use `{ feedback }`.
export async function getFeedback(userId: string, range = '90d'): Promise<FeedbackResponse> {
  if (mock()) return FIXTURE_FEEDBACK;
  const raw = await getJson<Partial<FeedbackResponse> & { votes?: FeedbackResponse['feedback'] }>(
    `/feedback/${uid(userId)}${query(range)}`,
  );
  return { feedback: raw.feedback ?? raw.votes ?? [] };
}

export async function getEvents(userId: string): Promise<AthleteEventsResponse> {
  if (mock()) return { events: mock() === 'empty' ? [] : FIXTURE_EVENTS };
  return getJson(`/athlete-events/${uid(userId)}`);
}

export async function putFeedback(userId: string, body: PutFeedbackBody): Promise<void> {
  if (mock()) return;
  await send(`/feedback/${uid(userId)}`, 'PUT', body);
}

export async function postEvent(
  userId: string,
  body: PostAthleteEventBody,
): Promise<AthleteEvent | null> {
  if (mock()) return null;
  const res = await send(`/athlete-events/${uid(userId)}`, 'POST', body);
  return (await res.json().catch(() => null)) as AthleteEvent | null;
}

export async function deleteEvent(userId: string, eventId: string): Promise<void> {
  if (mock()) return;
  await send(`/athlete-events/${uid(userId)}/${encodeURIComponent(eventId)}`, 'DELETE');
}

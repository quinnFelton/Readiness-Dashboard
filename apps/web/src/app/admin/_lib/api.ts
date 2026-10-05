import 'server-only';
import { apiFetch } from '../../../lib/auth/api-fetch';
import type {
  ClassifierComparisonRow,
  DeriverRow,
  Range,
  RosterConnection,
  RosterRow,
} from '../../../components/admin/types';

// Typed admin API client. All calls run server-side (tokens never reach the client bundle);
// the API re-enforces master-only with 403 regardless of the web middleware.

export class ApiError extends Error {
  constructor(
    public status: number,
    path: string,
  ) {
    super(`API ${path} failed: ${status}`);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new ApiError(res.status, path);
  return (await res.json()) as T;
}

interface UsersResponse {
  users: Array<{
    id: string;
    email: string;
    name: string | null;
    // Not served by GET /users yet (see report) — optional until the API adds them.
    connections?: RosterConnection[];
    lastSyncAt?: string | null;
    latestState?: string | null;
    latestStateAsOf?: string | null;
  }>;
}

// PLAN §7 trends row shape. The real 5b route (apps/api/src/trends/routes.ts) puts the classified
// state in `direction` for metricType 'fatigue_fitness_state'; `state` is accepted for older mocks.
interface TrendsResponse {
  trends: Array<{
    asOf: string;
    metricType: string;
    direction?: string | null;
    state?: string | null;
    classifierId?: string;
  }>;
}

export function latestFatigueState(t: TrendsResponse['trends']) {
  const rows = t
    .filter((r) => r.metricType === 'fatigue_fitness_state')
    .map((r) => ({ asOf: r.asOf, state: r.direction ?? r.state ?? null }))
    .filter((r) => r.state);
  rows.sort((a, b) => b.asOf.localeCompare(a.asOf));
  return rows[0] ?? null;
}

// Real 5b GET /comparison/classifiers row (apps/api/src/comparison/routes.ts).
interface ApiClassifierRow {
  id: string;
  description?: string | null;
  isDefault: boolean;
  agreement?: { up: number; down: number; rate: number | null };
  backtest?: { eventsConsidered?: number; eventsPreceded?: number; falseAlarms?: number };
}

/** Map the 5b shape onto the UI's ClassifierComparisonRow; rows already in UI shape pass through. */
export function toComparisonRow(
  r: ApiClassifierRow | ClassifierComparisonRow,
): ClassifierComparisonRow {
  if (!('agreement' in r) || r.agreement === undefined) return r as ClassifierComparisonRow;
  const bt = (r.backtest ?? {}) as NonNullable<ApiClassifierRow['backtest']>;
  const hits = bt.eventsPreceded ?? 0;
  return {
    id: r.id,
    description: r.description ?? null,
    isDefault: r.isDefault,
    votesUp: r.agreement.up,
    votesDown: r.agreement.down,
    agreementRate: r.agreement.rate,
    backtest: {
      hits,
      misses: Math.max(0, (bt.eventsConsidered ?? 0) - hits),
      falseAlarms: bt.falseAlarms ?? 0,
    },
  };
}

/** Roster: GET /users, enriched with each athlete's latest state when /users doesn't carry it. */
export async function fetchRoster(): Promise<RosterRow[]> {
  const { users } = await getJson<UsersResponse>('/users');
  return Promise.all(
    users.map(async (u) => {
      let state = u.latestState ?? null;
      let asOf = u.latestStateAsOf ?? null;
      if (u.latestState === undefined) {
        try {
          const latest = latestFatigueState(
            (await getJson<TrendsResponse>(`/trends/${u.id}`)).trends,
          );
          state = latest?.state ?? null;
          asOf = latest?.asOf ?? null;
        } catch {
          // one athlete's missing trends must not break the whole roster
        }
      }
      const connections = u.connections ?? [];
      const lastSyncAt =
        u.lastSyncAt ??
        connections
          .map((c) => c.lastSyncAt)
          .filter((x): x is string => !!x)
          .sort()
          .at(-1) ??
        null;
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        connections,
        latestState: state,
        latestStateAsOf: asOf,
        lastSyncAt,
      };
    }),
  );
}

export async function fetchClassifiers(range: Range): Promise<ClassifierComparisonRow[]> {
  return (
    await getJson<{ classifiers: Array<ApiClassifierRow | ClassifierComparisonRow> }>(
      `/comparison/classifiers?range=${range}`,
    )
  ).classifiers.map(toComparisonRow);
}

export async function fetchDerivers(): Promise<DeriverRow[]> {
  return (await getJson<{ derivers: DeriverRow[] }>('/comparison/derivers')).derivers;
}

export async function promoteClassifier(id: string): Promise<void> {
  const res = await apiFetch(`/comparison/classifiers/${encodeURIComponent(id)}/default`, {
    method: 'PUT',
  });
  if (!res.ok) throw new ApiError(res.status, 'promote');
}

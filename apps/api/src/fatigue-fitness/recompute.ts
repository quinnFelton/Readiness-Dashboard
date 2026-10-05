import { defaultRegistry } from '@rd/provider-adapters';
import { ConnectionConfigService } from '../connections/config-service';
import { addDays, isIsoDate, todayUtc } from '../trends/http';
import { getPool } from '../users/pool';
import { loadFatigueFitnessConfig } from './config';
import { markHistoryDirty, oldestOutsideWindow } from './history-rebuild';
import { FatigueFitnessService, type SyncKind } from './service';

// PLAN §8.4: trends / readiness_scores are computed when data arrives (sync, webhook, disconnect),
// never on dashboard load. Integration stage E wires every ingest path through this one hook.
//
// Contract for callers (ingest services, webhook routers, disconnect):
//  - it NEVER throws, so a failed recompute cannot fail the ingest or change a webhook's
//    `processed` status;
//  - failures are logged by error class name only (CLAUDE.md rule 6: messages may quote health data).

/**
 * Recompute a user's trends (and, for daily-metrics syncs, readiness) after new data landed.
 * `dates` are the days the ingest touched; today is always included.
 */
export type Recompute = (userId: string, kind: SyncKind, dates?: Iterable<string>) => Promise<void>;

export interface RecomputeOptions {
  now?: () => Date;
  /**
   * How far back an affected date may be and still be recomputed. Defaults to the long baseline
   * window (PLAN §8.2): an older date can't change today's window. It also bounds a 90-day Terra
   * backfill to at most `maxBackDays + 1` passes.
   */
  maxBackDays?: number;
  log?: (message: string) => void;
  /** Called with the oldest touched date that fell outside the window; see history-rebuild.ts. */
  markHistoryDirty?: (userId: string, oldestDate: string) => Promise<void>;
}

/** Today plus the distinct valid `dates` in (today - maxBackDays, today], oldest first. */
export function recomputeDates(
  dates: Iterable<string> | undefined,
  today: string,
  maxBackDays: number,
): string[] {
  const earliest = addDays(today, -(maxBackDays - 1));
  const out = new Set<string>([today]);
  for (const d of dates ?? []) {
    if (isIsoDate(d) && d >= earliest && d <= today) out.add(d);
  }
  // Oldest first, so flagged_at (set when a day's state differs from the stored one) runs forward.
  return [...out].sort();
}

/** Wraps a FatigueFitnessService (or a lazy getter for one) in the never-throwing hook. */
export function createRecompute(
  svc:
    | Pick<FatigueFitnessService, 'onSyncComplete'>
    | (() => Pick<FatigueFitnessService, 'onSyncComplete'>),
  opts: RecomputeOptions = {},
): Recompute {
  const get = typeof svc === 'function' ? svc : () => svc;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((m: string) => console.warn(m));
  return async (userId, kind, rawDates) => {
    try {
      const maxBack = opts.maxBackDays ?? loadFatigueFitnessConfig().longDays;
      const service = get();
      const today = todayUtc(now());
      const dates = rawDates ? [...rawDates] : undefined; // iterated twice below
      for (const day of recomputeDates(dates, today, maxBack)) {
        await service.onSyncComplete(userId, kind, day);
      }
      // Dates older than the window (a Terra 90-day backfill, an old Strava ride) get no rows here;
      // ask the history rebuild job to fill them in (history-rebuild.ts, owner decision 2026-10-04).
      const oldest = oldestOutsideWindow(dates, today, maxBack);
      if (oldest && opts.markHistoryDirty) await opts.markHistoryDirty(userId, oldest);
    } catch (err) {
      log(`fatigue-fitness recompute failed: ${err instanceof Error ? err.name : 'Error'}`);
    }
  };
}

let shared: FatigueFitnessService | undefined;
let sharedHook: Recompute | undefined;

/**
 * The process-wide hook: one FatigueFitnessService per process, built on first use (like
 * lazyStravaIngest), so routers can be mounted at startup without DB/env.
 */
export function sharedRecompute(): Recompute {
  sharedHook ??= createRecompute(
    () => {
      if (!shared) {
        const pool = getPool();
        shared = new FatigueFitnessService(
          pool,
          new ConnectionConfigService(pool, defaultRegistry),
        );
      }
      return shared;
    },
    { markHistoryDirty: (userId, oldest) => markHistoryDirty(getPool(), userId, oldest) },
  );
  return sharedHook;
}

/** The last `days` days ending today (UTC), for "rebuild the dashboard window" callers. */
export function lastDays(days: number, now: Date = new Date()): string[] {
  const today = todayUtc(now);
  return Array.from({ length: days }, (_, i) => addDays(today, -i));
}

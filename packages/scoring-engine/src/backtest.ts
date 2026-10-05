/**
 * Outcome backtest for classifiers (PLAN §8.7): did a warning flag fire *before* a real event,
 * and how many flags were followed by nothing?
 *
 * Pure: dates in, counts out. No clock (the caller says how far the data is evaluated), no DB.
 * Run it once per athlete and add the results with {@link sumBacktests}; flags and events of
 * different people must never be matched against each other.
 *
 * Definitions (all day gaps are calendar days, `event − flag`):
 * - A flag is a point whose `state` is in `config.flagStates`.
 * - An event counts if its `eventType` is in `config.eventTypes`.
 * - An event is **preceded** if some flag has 1 ≤ gap ≤ leadDays. A flag on the event's own day
 *   (gap 0) is concurrent, not a warning, and does not count.
 * - A flag is a **false alarm** if no counted event has 1 ≤ gap ≤ leadDays after it.
 * - A flag whose lead window isn't over yet (flagDay + leadDays > evaluatedThrough) can't be
 *   judged: an event may still be logged after the fact. It is reported as `flagsPending`
 *   and excluded from `flagsJudged` and `falseAlarms`.
 */
import { dayNumber } from './baseline';

export interface BacktestFlag {
  /** `YYYY-MM-DD`. */
  date: string;
  state: string;
}

export interface BacktestEvent {
  /** `YYYY-MM-DD`. */
  date: string;
  eventType: string;
}

/** Config, not constants (CLAUDE.md rule 9). */
export interface BacktestConfig {
  /** Integer >= 1. */
  leadDays: number;
  flagStates: readonly string[];
  eventTypes: readonly string[];
}

export interface BacktestOptions {
  /** Last date the data is complete through (inclusive). Decides which flags are still pending. */
  evaluatedThrough: string;
  /**
   * Only events and flags dated on/after this are *counted*; earlier flags are still used to
   * look back for events near the start of the range. Default: count everything.
   */
  from?: string;
}

export interface BacktestResult {
  eventsConsidered: number;
  eventsPreceded: number;
  flagsJudged: number;
  falseAlarms: number;
  flagsPending: number;
}

export const EMPTY_BACKTEST: Readonly<BacktestResult> = Object.freeze({
  eventsConsidered: 0,
  eventsPreceded: 0,
  flagsJudged: 0,
  falseAlarms: 0,
  flagsPending: 0,
});

export function validateBacktestConfig(c: BacktestConfig): void {
  if (!Number.isInteger(c.leadDays) || c.leadDays < 1) {
    throw new RangeError('leadDays must be an integer >= 1');
  }
}

export function backtestFlags(
  flags: readonly BacktestFlag[],
  events: readonly BacktestEvent[],
  config: BacktestConfig,
  options: BacktestOptions,
): BacktestResult {
  validateBacktestConfig(config);
  const flagStates = new Set(config.flagStates);
  const eventTypes = new Set(config.eventTypes);
  const through = dayNumber(options.evaluatedThrough);
  const from = options.from === undefined ? -Infinity : dayNumber(options.from);

  // A set of days: two flag rows on one day (e.g. several windows) are one warning.
  const flagDays = [
    ...new Set(flags.filter((f) => flagStates.has(f.state)).map((f) => dayNumber(f.date))),
  ];
  const eventDays = events.filter((e) => eventTypes.has(e.eventType)).map((e) => dayNumber(e.date));
  const inLead = (flagDay: number, eventDay: number) => {
    const gap = eventDay - flagDay;
    return gap >= 1 && gap <= config.leadDays;
  };

  let eventsConsidered = 0;
  let eventsPreceded = 0;
  for (const ed of eventDays) {
    if (ed < from) continue;
    eventsConsidered++;
    if (flagDays.some((fd) => inLead(fd, ed))) eventsPreceded++;
  }

  let flagsJudged = 0;
  let falseAlarms = 0;
  let flagsPending = 0;
  for (const fd of flagDays) {
    if (fd < from) continue;
    if (fd + config.leadDays > through) {
      flagsPending++;
      continue;
    }
    flagsJudged++;
    if (!eventDays.some((ed) => inLead(fd, ed))) falseAlarms++;
  }

  return { eventsConsidered, eventsPreceded, flagsJudged, falseAlarms, flagsPending };
}

/** Field-wise sum, for combining per-athlete results. */
export function sumBacktests(results: readonly BacktestResult[]): BacktestResult {
  const out = { ...EMPTY_BACKTEST };
  for (const r of results) {
    out.eventsConsidered += r.eventsConsidered;
    out.eventsPreceded += r.eventsPreceded;
    out.flagsJudged += r.flagsJudged;
    out.falseAlarms += r.falseAlarms;
    out.flagsPending += r.flagsPending;
  }
  return out;
}

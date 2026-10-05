import { describe, expect, it } from 'vitest';
import { EMPTY_BACKTEST, backtestFlags, sumBacktests, type BacktestConfig } from './backtest';

const config: BacktestConfig = {
  leadDays: 3,
  flagStates: ['overreaching_risk', 'acute_fatigue'],
  eventTypes: ['illness', 'injury'],
};

// Hand-checked fixture (lead = 3 days; gap = event − flag):
//  events counted: illness 01-04, injury 01-15, illness 01-05 (race 01-21 is ignored: wrong type)
//   illness 01-04 ← flags 01-01 (gap 3) and 01-02 (gap 2)  → preceded
//   injury  01-15 ← 01-10 is gap 5 (too early)             → NOT preceded
//   illness 01-05 ← 01-02 (gap 3)                          → preceded
//   ⇒ eventsConsidered 3, eventsPreceded 2
//  flags counted: 01-01, 01-02, 01-10, 01-20, 02-09 ('ambiguous' 01-30 is ignored: wrong state)
//   01-01 → illness 01-04 (gap 3) hit        01-02 → illness 01-04 (gap 2) hit
//   01-10 → injury 01-15 is gap 5: false alarm
//   01-20 → race 01-21 is the wrong type: false alarm
//   02-09 → 02-09 + 3 > evaluatedThrough 02-10: pending
//   ⇒ flagsJudged 4, falseAlarms 2, flagsPending 1
const flags = [
  { date: '2026-01-01', state: 'overreaching_risk' },
  { date: '2026-01-02', state: 'acute_fatigue' },
  { date: '2026-01-10', state: 'overreaching_risk' },
  { date: '2026-01-20', state: 'acute_fatigue' },
  { date: '2026-01-30', state: 'ambiguous' },
  { date: '2026-02-09', state: 'overreaching_risk' },
];
const events = [
  { date: '2026-01-04', eventType: 'illness' },
  { date: '2026-01-15', eventType: 'injury' },
  { date: '2026-01-21', eventType: 'race' },
  { date: '2026-01-05', eventType: 'illness' },
];

describe('backtestFlags', () => {
  it('matches the hand-checked fixture', () => {
    expect(backtestFlags(flags, events, config, { evaluatedThrough: '2026-02-10' })).toEqual({
      eventsConsidered: 3,
      eventsPreceded: 2,
      flagsJudged: 4,
      falseAlarms: 2,
      flagsPending: 1,
    });
  });

  it('a flag on the event day is concurrent, not a warning', () => {
    const r = backtestFlags(
      [{ date: '2026-03-01', state: 'acute_fatigue' }],
      [{ date: '2026-03-01', eventType: 'illness' }],
      config,
      { evaluatedThrough: '2026-04-01' },
    );
    expect(r.eventsPreceded).toBe(0);
    expect(r.falseAlarms).toBe(1);
  });

  it('lead window boundaries: gap 1 and gap leadDays count, leadDays+1 does not', () => {
    const ev = [{ date: '2026-03-10', eventType: 'injury' }];
    const run = (flagDate: string) =>
      backtestFlags([{ date: flagDate, state: 'acute_fatigue' }], ev, config, {
        evaluatedThrough: '2026-06-01',
      });
    expect(run('2026-03-09').eventsPreceded).toBe(1);
    expect(run('2026-03-07').eventsPreceded).toBe(1);
    expect(run('2026-03-06').eventsPreceded).toBe(0);
  });

  it('counts one warning per day even with duplicate flag rows', () => {
    const dup = [
      { date: '2026-03-01', state: 'acute_fatigue' },
      { date: '2026-03-01', state: 'overreaching_risk' },
    ];
    const r = backtestFlags(dup, [], config, { evaluatedThrough: '2026-04-01' });
    expect(r.flagsJudged).toBe(1);
    expect(r.falseAlarms).toBe(1);
  });

  it('`from` only limits what is counted; earlier flags still warn about early events', () => {
    const r = backtestFlags(flags, events, config, {
      evaluatedThrough: '2026-02-10',
      from: '2026-01-04',
    });
    // illness 01-04 (still preceded by 01-01/01-02), 01-05, injury 01-15 counted; flags 01-01/02 not counted
    expect(r).toEqual({
      eventsConsidered: 3,
      eventsPreceded: 2,
      flagsJudged: 2, // 01-10, 01-20
      falseAlarms: 2,
      flagsPending: 1,
    });
  });

  it('empty input gives zeros', () => {
    expect(backtestFlags([], [], config, { evaluatedThrough: '2026-01-01' })).toEqual(
      EMPTY_BACKTEST,
    );
  });

  it('validates config and dates', () => {
    expect(() =>
      backtestFlags([], [], { ...config, leadDays: 0 }, { evaluatedThrough: '2026-01-01' }),
    ).toThrow(RangeError);
    expect(() => backtestFlags([], [], config, { evaluatedThrough: '2026-13-01' })).toThrow(
      RangeError,
    );
  });
});

describe('sumBacktests', () => {
  it('adds field-wise and handles empty', () => {
    const a = {
      eventsConsidered: 3,
      eventsPreceded: 2,
      flagsJudged: 4,
      falseAlarms: 2,
      flagsPending: 1,
    };
    expect(sumBacktests([a, a])).toEqual({
      eventsConsidered: 6,
      eventsPreceded: 4,
      flagsJudged: 8,
      falseAlarms: 4,
      flagsPending: 2,
    });
    expect(sumBacktests([])).toEqual(EMPTY_BACKTEST);
  });
});

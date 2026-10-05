import { describe, expect, it, vi } from 'vitest';
import { createRecompute, lastDays, recomputeDates } from './recompute';

// Pure tests of the never-throwing recompute hook (no DB). The DB-backed wiring tests, one per ingest
// path, are in recompute-wiring.test.ts.

const NOW = new Date('2026-03-28T12:00:00Z');

describe('recomputeDates', () => {
  it('always includes today, dedupes, keeps only the window, sorts oldest first', () => {
    expect(
      recomputeDates(
        ['2026-03-27', '2026-03-01', '2026-03-27', '2026-02-28', '2026-03-29', 'nope'],
        '2026-03-28',
        28,
      ),
    ).toEqual(['2026-03-01', '2026-03-27', '2026-03-28']);
  });

  it('is just today with no dates', () => {
    expect(recomputeDates(undefined, '2026-03-28', 28)).toEqual(['2026-03-28']);
  });
});

describe('lastDays', () => {
  it('returns `days` days ending today', () => {
    expect(lastDays(3, NOW)).toEqual(['2026-03-28', '2026-03-27', '2026-03-26']);
  });
});

describe('createRecompute', () => {
  it('runs one onSyncComplete per window day, oldest first, with the trigger kind', async () => {
    const onSyncComplete = vi.fn(async () => ({}) as never);
    const hook = createRecompute({ onSyncComplete }, { now: () => NOW, maxBackDays: 28 });
    await hook('u1', 'activity', ['2026-03-20']);
    expect(onSyncComplete.mock.calls).toEqual([
      ['u1', 'activity', '2026-03-20'],
      ['u1', 'activity', '2026-03-28'],
    ]);
  });

  it('never throws; logs the error class name only, never the message', async () => {
    const log = vi.fn();
    const hook = createRecompute(
      {
        onSyncComplete: async () => {
          throw new RangeError('hrv=63 for someone');
        },
      },
      { now: () => NOW, maxBackDays: 28, log },
    );
    await expect(hook('u1', 'daily_metrics')).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('fatigue-fitness recompute failed: RangeError');
    expect(JSON.stringify(log.mock.calls)).not.toContain('hrv');
  });

  it('a failing lazy service getter is also contained', async () => {
    const log = vi.fn();
    const hook = createRecompute(
      () => {
        throw new TypeError('no pool');
      },
      { now: () => NOW, maxBackDays: 28, log },
    );
    await expect(hook('u1', 'activity')).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('fatigue-fitness recompute failed: TypeError');
  });

  it('builds the service lazily, once', async () => {
    const factory = vi.fn(() => ({ onSyncComplete: async () => ({}) as never }));
    const hook = createRecompute(factory, { now: () => NOW, maxBackDays: 28 });
    expect(factory).not.toHaveBeenCalled();
    await hook('u1', 'activity');
    // The getter is invoked per call; caching lives in sharedRecompute's factory. What matters is
    // that nothing is built at construction (routers are mounted before DB/env exist).
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

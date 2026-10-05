import { describe, expect, it } from 'vitest';
import { FIXTURE_TRENDS } from './fixtures';
import {
  currentState,
  eventMarkers,
  extractStateHistory,
  findVote,
  latestDate,
  rangeStart,
  statesToBands,
  summarizeMetric,
  windowStats,
  type StatePoint,
} from './model';
import { isFlagged } from './state-meta';

const sp = (asOf: string, state: string): StatePoint => ({
  asOf,
  state,
  insightText: null,
  classifierId: 'c',
});

describe('state history', () => {
  it('extracts one state per date ascending, ignoring metric rows', () => {
    const h = extractStateHistory(FIXTURE_TRENDS.trends);
    expect(h.map((p) => p.state)).toEqual([
      'steady',
      'fitness_gain',
      'overreaching_risk',
      'overreaching_risk',
    ]);
  });

  it('prefers the 28d row when both windows exist for a date', () => {
    const base = FIXTURE_TRENDS.trends[0]!;
    const h = extractStateHistory([
      { ...base, window: '7d', direction: 'acute_fatigue' },
      { ...base, window: '28d', direction: 'steady' },
    ]);
    expect(h).toHaveLength(1);
    expect(h[0]?.state).toBe('steady');
  });

  it('currentState reports the start of the trailing run', () => {
    const cur = currentState([
      sp('2026-09-01', 'steady'),
      sp('2026-09-05', 'overreaching_risk'),
      sp('2026-09-09', 'overreaching_risk'),
    ]);
    expect(cur).toMatchObject({ state: 'overreaching_risk', since: '2026-09-05' });
    expect(currentState([])).toBeNull();
  });

  it('statesToBands merges runs, ends at the next state, skips insufficient_data', () => {
    const bands = statesToBands(
      [
        sp('2026-09-01', 'insufficient_data'),
        sp('2026-09-03', 'fitness_gain'),
        sp('2026-09-05', 'fitness_gain'),
        sp('2026-09-08', 'acute_fatigue'),
      ],
      '2026-09-12',
    );
    expect(bands.map((b) => [b.label, b.start, b.end])).toEqual([
      ['Fitness gain', '2026-09-03', '2026-09-08'],
      ['Acute fatigue', '2026-09-08', '2026-09-12'],
    ]);
  });

  it('isFlagged excludes steady and insufficient_data', () => {
    expect(isFlagged('overreaching_risk')).toBe(true);
    expect(isFlagged('steady')).toBe(false);
    expect(isFlagged('insufficient_data')).toBe(false);
    expect(isFlagged('bogus')).toBe(false);
  });
});

describe('windows and ranges', () => {
  const pts = [
    { date: '2026-09-01', value: 10 },
    { date: '2026-09-20', value: 20 },
    { date: '2026-09-26', value: 40 },
  ];

  it('windowStats averages only points inside the inclusive window', () => {
    expect(windowStats(pts, '2026-09-26', 7)).toEqual({ mean: 30, count: 2 });
    expect(windowStats(pts, '2026-09-26', 28)).toEqual({ mean: (10 + 20 + 40) / 3, count: 3 });
    expect(windowStats(pts, '2026-08-01', 7)).toEqual({ mean: null, count: 0 });
  });

  it('latestDate / rangeStart', () => {
    expect(latestDate(FIXTURE_TRENDS.series, [])).toBe('2026-09-27');
    expect(rangeStart('2026-09-28', 28)).toBe('2026-09-01');
  });

  it('summarizeMetric joins local means with server z-scores', () => {
    const [w7, w28] = summarizeMetric(
      FIXTURE_TRENDS.series.hrv,
      FIXTURE_TRENDS.trends,
      'hrv',
      '2026-09-27',
    );
    expect(w7).toMatchObject({ window: '7d', zScore: -1.2, direction: 'down', count: 7 });
    expect(w28).toMatchObject({ window: '28d', zScore: -0.3, count: 27 });
  });
});

describe('events and votes', () => {
  it('eventMarkers never include notes', () => {
    const m = eventMarkers(
      [{ id: '1', date: '2026-09-20', eventType: 'illness', notes: 'secret' }],
      '2026-09-01',
    );
    expect(m).toHaveLength(1);
    expect(JSON.stringify(m)).not.toContain('secret');
  });

  it('findVote matches classifier, date and voter', () => {
    const fb = [
      { classifierId: 'c', asOf: 'd', state: 's', vote: 1 as const, comment: null, votedBy: 'me' },
      {
        classifierId: 'c',
        asOf: 'd',
        state: 's',
        vote: -1 as const,
        comment: null,
        votedBy: 'other',
      },
    ];
    expect(findVote(fb, 'c', 'd', 'me')?.vote).toBe(1);
    expect(findVote(fb, 'c', 'x', 'me')).toBeNull();
  });
});

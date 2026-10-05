// Integration stage D: the web clients must accept the response shapes the real 5b routes emit
// (apps/api/src/{trends,feedback,comparison}/routes.ts), not just the shapes 6a/6b mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const apiFetch = vi.fn();
vi.mock('../../lib/auth/api-fetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { fetchClassifiers, latestFatigueState, toComparisonRow } from '../../app/admin/_lib/api';
import { getFeedback, getScores, getTrends } from './api';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  apiFetch.mockReset();
  delete process.env.DASHBOARD_MOCK;
});

const row5b = {
  asOf: '2026-10-03',
  metricType: 'fatigue_fitness_state',
  window: '7d',
  zScore: 1.1,
  recoveryZ: -0.9,
  direction: 'overreaching_risk',
  insightText: 'EF rising while HRV falling',
  flaggedAt: '2026-10-03T06:00:00.000Z',
};

describe('dashboard client ← 5b /trends, /scores, /feedback', () => {
  it('copies the top-level classifierId onto rows and defaults series to empty arrays', async () => {
    apiFetch.mockResolvedValue(
      json({ userId: 'u1', classifierId: 'ef_quadrant_v1', range: '90d', trends: [row5b] }),
    );
    const t = await getTrends('u1');
    expect(t.classifierId).toBe('ef_quadrant_v1');
    expect(t.trends[0]).toMatchObject({
      classifierId: 'ef_quadrant_v1',
      direction: 'overreaching_risk',
    });
    expect(t.series).toEqual({ efPeak20: [], efOverall: [], hrv: [], restingHr: [] });
  });

  it('keeps a series if the API provides one', async () => {
    const hrv = [{ date: '2026-10-03', value: 55 }];
    apiFetch.mockResolvedValue(json({ classifierId: 'c', trends: [], series: { hrv } }));
    expect((await getTrends('u1')).series.hrv).toEqual(hrv);
  });

  it('sends ?classifier= only when one is chosen', async () => {
    apiFetch.mockImplementation(async () => json({ classifierId: 'c', trends: [], scores: [] }));
    await getTrends('u1', '90d', 'alt_v2');
    expect(apiFetch).toHaveBeenLastCalledWith('/trends/u1?range=90d&classifier=alt_v2');
    await getTrends('u1', '90d', null);
    expect(apiFetch).toHaveBeenLastCalledWith('/trends/u1?range=90d');
    await getScores('u1', '28d', 'alt_v2');
    expect(apiFetch).toHaveBeenLastCalledWith('/scores/u1?range=28d&classifier=alt_v2');
  });

  it('maps the 5b feedback `votes` list onto `feedback`', async () => {
    const vote = {
      asOf: '2026-10-03',
      classifierId: 'ef_quadrant_v1',
      state: 'overreaching_risk',
      vote: 1,
      comment: null,
      votedBy: 'u1',
    };
    apiFetch.mockResolvedValue(json({ userId: 'u1', range: '90d', votes: [vote] }));
    expect((await getFeedback('u1')).feedback).toEqual([vote]);
  });
});

describe('admin client ← 5b /trends and /comparison/classifiers', () => {
  it('roster state comes from `direction` on fatigue_fitness_state rows', () => {
    expect(
      latestFatigueState([
        { ...row5b, asOf: '2026-10-01', direction: 'fitness_gain' },
        row5b,
        { ...row5b, metricType: 'hrv', asOf: '2026-10-04', direction: 'up' },
      ]),
    ).toEqual({ asOf: '2026-10-03', state: 'overreaching_risk' });
  });

  it('maps agreement + backtest counts onto the table row shape', async () => {
    apiFetch.mockResolvedValue(
      json({
        range: '90d',
        classifiers: [
          {
            id: 'ef_quadrant_v1',
            description: 'default',
            isDefault: true,
            registered: true,
            agreement: { up: 3, down: 1, rate: 0.75 },
            backtest: {
              eventsConsidered: 4,
              eventsPreceded: 3,
              flagsJudged: 5,
              falseAlarms: 2,
              flagsPending: 1,
              recall: 0.75,
              falseAlarmRate: 0.4,
            },
          },
        ],
      }),
    );
    expect(await fetchClassifiers('90d')).toEqual([
      {
        id: 'ef_quadrant_v1',
        description: 'default',
        isDefault: true,
        votesUp: 3,
        votesDown: 1,
        agreementRate: 0.75,
        backtest: { hits: 3, misses: 1, falseAlarms: 2 },
      },
    ]);
  });

  it('passes rows already in UI shape through untouched', () => {
    const ui = {
      id: 'x',
      isDefault: false,
      votesUp: 0,
      votesDown: 0,
      agreementRate: null,
      backtest: { hits: 0, misses: 0, falseAlarms: 0 },
    };
    expect(toComparisonRow(ui)).toBe(ui);
  });
});

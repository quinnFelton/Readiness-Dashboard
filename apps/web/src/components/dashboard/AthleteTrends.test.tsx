// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_TRENDS, FIXTURE_EVENTS, FIXTURE_SCORES, FIXTURE_TRENDS } from './fixtures';
import type { LoadResult } from './load';

const load = vi.fn<(userId: string) => Promise<LoadResult>>();
vi.mock('./load', () => ({ loadDashboardData: (id: string) => load(id) }));
vi.mock('../../app/dashboard/actions', () => ({ submitVote: vi.fn() }));
vi.mock('../charts', () => ({ TimeSeriesChart: () => <div data-testid="chart" /> }));

import { AthleteTrends } from './AthleteTrends';
import { findVote } from './model';

type Data = Extract<LoadResult, { ok: true }>['data'];
const ok = (over: Partial<Data> = {}): LoadResult => ({
  ok: true,
  data: {
    trends: FIXTURE_TRENDS,
    scores: FIXTURE_SCORES.scores,
    feedback: [],
    feedbackFailed: false,
    events: FIXTURE_EVENTS,
    eventsFailed: false,
    ...over,
  },
});

beforeEach(() => load.mockReset());
afterEach(cleanup);

describe('AthleteTrends', () => {
  it('renders four metrics with 7d and 28d rows', async () => {
    load.mockResolvedValue(ok());
    render(await AthleteTrends({ userId: 'u1', viewerId: 'u1' }));
    for (const t of ['EF peak-20', 'EF overall', 'HRV', 'Resting HR'])
      expect(screen.getByRole('heading', { name: t })).toBeInTheDocument();
    expect(screen.getAllByRole('rowheader', { name: '7d' })).toHaveLength(4);
    expect(screen.getAllByRole('rowheader', { name: '28d' })).toHaveLength(4);
    expect(screen.getAllByText('-1.2')).toHaveLength(4);
  });

  it('offers a rating per flagged state; steady is not rated', async () => {
    load.mockResolvedValue(ok());
    render(await AthleteTrends({ userId: 'u1', viewerId: 'u1' }));
    // fixture: fitness_gain + 2 overreaching rows flagged; steady is not
    expect(screen.getAllByRole('button', { name: /thumbs up/i })).toHaveLength(3);
  });

  it('empty user is sent to connections', async () => {
    load.mockResolvedValue(ok({ trends: EMPTY_TRENDS, scores: [], events: [] }));
    render(await AthleteTrends({ userId: 'u1', viewerId: 'u1' }));
    expect(screen.getByRole('link')).toHaveAttribute('href', '/settings/connections');
  });
});

describe('findVote attribution', () => {
  const fb = [
    {
      classifierId: 'c',
      asOf: '2026-09-27',
      state: 's',
      vote: 1 as const,
      comment: null,
      votedBy: 'athlete',
    },
  ];
  it('only returns the viewer own vote', () => {
    expect(findVote(fb, 'c', '2026-09-27', 'athlete')?.vote).toBe(1);
    expect(findVote(fb, 'c', '2026-09-27', 'coach')).toBeNull();
    expect(findVote(fb, 'c', '2026-09-28', 'athlete')).toBeNull();
  });
});

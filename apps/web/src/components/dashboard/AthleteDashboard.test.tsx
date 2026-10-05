// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_TRENDS,
  FIXTURE_EVENTS,
  FIXTURE_FEEDBACK,
  FIXTURE_SCORES,
  FIXTURE_TRENDS,
} from './fixtures';
import type { LoadResult } from './load';

const loadDashboardData = vi.fn<(userId: string) => Promise<LoadResult>>();
vi.mock('./load', () => ({ loadDashboardData: (id: string) => loadDashboardData(id) }));
vi.mock('../../app/dashboard/actions', () => ({
  submitVote: vi.fn(),
  logEvent: vi.fn(),
  removeEvent: vi.fn(),
}));
// Recharts needs real layout; the chart's own logic is covered in chart-data.test.ts.
vi.mock('../charts', () => ({
  TimeSeriesChart: (p: { title: string; bands?: unknown[]; markers?: unknown[] }) => (
    <div
      data-testid="chart"
      data-bands={p.bands?.length ?? 0}
      data-markers={p.markers?.length ?? 0}
    >
      {p.title}
    </div>
  ),
}));

import { AthleteDashboard } from './AthleteDashboard';

const ok = (over: Partial<Extract<LoadResult, { ok: true }>['data']> = {}): LoadResult => ({
  ok: true,
  data: {
    trends: FIXTURE_TRENDS,
    scores: FIXTURE_SCORES.scores,
    feedback: FIXTURE_FEEDBACK.feedback,
    feedbackFailed: false,
    events: FIXTURE_EVENTS,
    eventsFailed: false,
    ...over,
  },
});

async function renderDash(props: Partial<Parameters<typeof AthleteDashboard>[0]> = {}) {
  render(await AthleteDashboard({ userId: 'u1', viewerId: 'u1', ...props }));
}

beforeEach(() => loadDashboardData.mockReset());
afterEach(cleanup);

describe('AthleteDashboard', () => {
  it('shows the hero state, since-date, insight, readiness and chart overlays', async () => {
    loadDashboardData.mockResolvedValue(ok());
    await renderDash();
    // badge + chart legend entry
    expect(screen.getAllByText('Overreaching risk')).toHaveLength(2);
    expect(screen.getByText(/since 2026-09-23/)).toBeInTheDocument();
    expect(screen.getByText(/overreaching risk\./i)).toBeInTheDocument();
    expect(screen.getByText('Readiness score')).toBeInTheDocument();
    const charts = screen.getAllByTestId('chart');
    expect(charts[0]).toHaveAttribute('data-bands', '3'); // steady, fitness_gain, overreaching
    expect(charts[0]).toHaveAttribute('data-markers', '1'); // the logged illness
    expect(screen.getByRole('button', { name: /thumbs up/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log event' })).toBeInTheDocument();
  });

  it('shows my existing vote on the hero insight', async () => {
    loadDashboardData.mockResolvedValue(
      ok({
        feedback: [
          {
            classifierId: 'ef_quadrant_v1',
            asOf: '2026-09-27',
            state: 'overreaching_risk',
            vote: 1,
            comment: null,
            votedBy: 'u1',
          },
        ],
      }),
    );
    await renderDash();
    expect(screen.getByRole('button', { name: /thumbs up/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('sends a new user to /settings/connections', async () => {
    loadDashboardData.mockResolvedValue(ok({ trends: EMPTY_TRENDS, scores: [], events: [] }));
    await renderDash();
    expect(screen.getByRole('link', { name: /connect your data sources/i })).toHaveAttribute(
      'href',
      '/settings/connections',
    );
  });

  it('coach view of an empty athlete has no connect link', async () => {
    loadDashboardData.mockResolvedValue(ok({ trends: EMPTY_TRENDS, scores: [], events: [] }));
    await renderDash({ userId: 'athlete', viewerId: 'coach' });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/has not connected/i)).toBeInTheDocument();
  });

  it('renders an error state when the trends load fails', async () => {
    loadDashboardData.mockResolvedValue({ ok: false, message: 'We could not load this data.' });
    await renderDash();
    expect(screen.getByRole('alert')).toHaveTextContent('We could not load this data.');
  });

  it('loads data for the given userId (coach drill-down)', async () => {
    loadDashboardData.mockResolvedValue(ok());
    await renderDash({ userId: 'athlete', viewerId: 'coach' });
    expect(loadDashboardData).toHaveBeenCalledWith('athlete');
  });
});

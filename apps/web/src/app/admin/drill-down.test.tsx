// @vitest-environment jsdom
// Integration stage D: the admin drill-down renders 6a's AthleteDashboard (no placeholder) and threads
// 6b's `?classifier=` selection into the trends/scores requests it makes against the real 5b
// response shape (apps/api/src/trends/routes.ts: `{ userId, classifierId, range, trends }`).
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const apiFetch = vi.fn();
vi.mock('../../lib/auth/api-fetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
const auth = vi.fn();
vi.mock('../../lib/auth', () => ({ auth: () => auth() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock('../dashboard/actions', () => ({
  submitVote: vi.fn(),
  logEvent: vi.fn(),
  removeEvent: vi.fn(),
}));
vi.mock('../../components/charts', () => ({
  TimeSeriesChart: (p: { title: string }) => <div data-testid="chart">{p.title}</div>,
}));

import { AthleteDashboard } from '../../components/dashboard/AthleteDashboard';
import { AthleteDashboardSlot } from '../../components/admin/AthleteDashboardSlot';
import Page from './athletes/[userId]/page';

const U = '22222222-2222-4222-8222-222222222222';
const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

// A 5b trends row. The real API puts classifierId at the top level only, not on each row.
const state = (asOf: string, direction: string, insightText: string) => ({
  asOf,
  metricType: 'fatigue_fitness_state',
  window: '7d',
  zScore: 1.2,
  recoveryZ: -0.8,
  direction,
  insightText,
  flaggedAt: `${asOf}T06:00:00.000Z`,
});

function trendsFor(classifier: string | null) {
  const id = classifier ?? 'ef_quadrant_v1';
  const trends =
    id === 'alt_v2'
      ? [state('2026-10-03', 'overreaching_risk', 'ALT: EF up while HRV falls')]
      : [state('2026-10-03', 'fitness_gain', 'DEFAULT: EF rising, recovery stable')];
  return { userId: U, classifierId: id, range: '90d', trends };
}

function mockApi() {
  apiFetch.mockImplementation(async (path: string) => {
    if (path.startsWith('/comparison/classifiers'))
      return json({
        classifiers: [
          {
            id: 'ef_quadrant_v1',
            isDefault: true,
            agreement: { up: 0, down: 0, rate: null },
            backtest: {},
          },
          {
            id: 'alt_v2',
            isDefault: false,
            agreement: { up: 0, down: 0, rate: null },
            backtest: {},
          },
        ],
      });
    const url = new URL(path, 'http://x');
    const classifier = url.searchParams.get('classifier');
    if (url.pathname === `/trends/${U}`) return json(trendsFor(classifier));
    if (url.pathname === `/scores/${U}`)
      return json({ userId: U, classifierId: classifier, range: '28d', scores: [] });
    if (url.pathname === `/feedback/${U}`) return json({ userId: U, range: '90d', votes: [] });
    if (url.pathname === `/athlete-events/${U}`) return json({ userId: U, events: [] });
    return json({}, 404);
  });
}

/** Resolve the async server components in the page tree so jsdom can render it. */
const SERVER = new Set<unknown>([AthleteDashboardSlot, AthleteDashboard]);
async function resolveTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveTree));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (SERVER.has(el.type)) {
    return resolveTree(await (el.type as (p: unknown) => ReactNode | Promise<ReactNode>)(el.props));
  }
  if (el.props.children === undefined) return el;
  const kids = await Promise.all(Children.toArray(el.props.children).map(resolveTree));
  return cloneElement(el, undefined, ...kids);
}

async function renderPage(classifier?: string) {
  const el = await Page({
    params: Promise.resolve({ userId: U }),
    searchParams: Promise.resolve(classifier === undefined ? {} : { classifier }),
  });
  render(<>{await resolveTree(el)}</>);
}

const trendsCalls = () =>
  apiFetch.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith('/trends/'));

beforeEach(() => {
  apiFetch.mockReset();
  auth.mockResolvedValue({ user: { id: 'master-1', role: 'master' } });
  mockApi();
});
afterEach(cleanup);

describe('admin athlete drill-down (6b → 6a, integration D)', () => {
  it('renders the real AthleteDashboard (no placeholder) with the default classifier', async () => {
    await renderPage();
    expect(screen.queryByTestId('athlete-dashboard-placeholder')).toBeNull();
    expect(screen.getByText('Current state')).toBeInTheDocument();
    expect(screen.getByText(/DEFAULT: EF rising/)).toBeInTheDocument();
    expect(trendsCalls()).toEqual([`/trends/${U}?range=90d`]);
    expect(screen.queryByRole('alert')).toBeNull(); // no non-default warning
    // coach view: the breakdown link stays inside admin, not the master's own /dashboard/trends
    expect(screen.getByRole('link', { name: /metric breakdown/i })).toHaveAttribute(
      'href',
      `/admin/athletes/${U}/trends`,
    );
  });

  it('switching ?classifier= changes the trends rows requested and shown, with the non-default label', async () => {
    await renderPage('alt_v2');
    expect(trendsCalls()).toEqual([`/trends/${U}?range=90d&classifier=alt_v2`]);
    expect(apiFetch).toHaveBeenCalledWith(`/scores/${U}?range=28d&classifier=alt_v2`);
    expect(screen.getByText(/ALT: EF up while HRV falls/)).toBeInTheDocument();
    expect(screen.queryByText(/DEFAULT: EF rising/)).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Viewing non-default classifier alt_v2.*they see ef_quadrant_v1/,
    );
    expect(screen.getByRole('link', { name: /metric breakdown/i })).toHaveAttribute(
      'href',
      `/admin/athletes/${U}/trends?classifier=alt_v2`,
    );
  });

  it('an unknown ?classifier= is not forwarded to the API', async () => {
    await renderPage('nope_v9');
    expect(trendsCalls()).toEqual([`/trends/${U}?range=90d`]);
  });
});

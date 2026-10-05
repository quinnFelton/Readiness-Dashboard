// @vitest-environment jsdom
// Integration stage D: tests the 6c tester could not write before vitest.config.ts got the `@/`
// alias (docs/reports/6c-test-report.md). ConnectionsPanel is rendered with an overview built by the
// real server loader (app/settings/_lib/server.ts) from mocked API responses.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const apiFetch = vi.fn();
vi.mock('@/lib/auth/api-fetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
const actions = {
  startConnection: vi.fn(),
  disconnectProvider: vi.fn(),
  saveSources: vi.fn(),
};
vi.mock('@/app/settings/_lib/actions', () => ({
  startConnection: (...a: unknown[]) => actions.startConnection(...a),
  disconnectProvider: (...a: unknown[]) => actions.disconnectProvider(...a),
  saveSources: (...a: unknown[]) => actions.saveSources(...a),
}));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { loadOverview } from '@/app/settings/_lib/server';
import type { ConnectionsOverview } from '@/app/settings/_lib/types';
import { ConnectionsPanel } from './ConnectionsPanel';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Registry as the API would list it (deliberately different from FALLBACK_PROVIDERS).
const REGISTRY = [
  { key: 'oura', role: 'daily_metrics_source', displayName: 'Oura Ring', flow: 'oauth' },
  { key: 'strava', role: 'activity_source', displayName: 'Strava Rides', flow: 'oauth' },
  { key: 'terra', role: 'daily_metrics_source', displayName: 'Zepp via Terra', flow: 'widget' },
];
const conn = (provider: string, role: string) => ({
  id: `c-${provider}`,
  userId: 'u1',
  provider,
  role,
  externalUserId: null,
  expiresAt: null,
  isActive: true,
  lastSyncedAt: null,
  connectedAt: '2026-09-01T00:00:00Z',
});
const PREC = { hrv: ['oura'], resting_hr: ['oura'], sleep_score: ['oura'], readiness: ['oura'] };

function mockApi(daily: string[], connections: ReturnType<typeof conn>[] = []) {
  apiFetch.mockImplementation(async (path: string) => {
    if (path === '/connections/providers') return json({ providers: REGISTRY });
    if (path === '/connections/config')
      return json({
        config: { activitySource: 'strava', dailyMetricsSources: daily },
        precedence: PREC,
        connections,
      });
    return json({}, 404);
  });
}

async function renderPanel(daily: string[], connections: ReturnType<typeof conn>[] = []) {
  mockApi(daily, connections);
  const overview: ConnectionsOverview = await loadOverview();
  render(<ConnectionsPanel overview={overview} />);
  return overview;
}

const assign = vi.fn();
beforeEach(() => {
  apiFetch.mockReset();
  for (const f of Object.values(actions)) f.mockReset();
  actions.saveSources.mockResolvedValue({ ok: true });
  assign.mockReset();
  vi.stubGlobal('location', { ...window.location, assign });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ConnectionsPanel with the API registry', () => {
  it('lists providers grouped by role from GET /connections/providers', async () => {
    const overview = await renderPanel(['oura']);
    expect(apiFetch).toHaveBeenCalledWith('/connections/providers');
    expect(overview.providers.map((p) => p.displayName)).toEqual([
      'Oura Ring',
      'Strava Rides',
      'Zepp via Terra',
    ]);
    const activity = screen.getByRole('region', { name: 'Activity source' });
    const daily = screen.getByRole('region', { name: 'Daily metrics sources' });
    expect(within(activity).getByText('Strava Rides')).toBeInTheDocument();
    expect(within(activity).queryByText('Oura Ring')).toBeNull();
    expect(within(activity).getByRole('radio', { name: 'Use Strava Rides' })).toBeChecked();
    expect(within(daily).getByText('Oura Ring')).toBeInTheDocument();
    expect(within(daily).getByText('Zepp via Terra')).toBeInTheDocument();
    expect(within(daily).queryByText('Strava Rides')).toBeNull();
    expect(within(daily).getAllByRole('checkbox')).toHaveLength(2);
  });

  it('falls back to the built-in provider list only when the registry endpoint is missing (404)', async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path === '/connections/config'
        ? json({
            config: { activitySource: null, dailyMetricsSources: [] },
            precedence: PREC,
            connections: [],
          })
        : json({}, 404),
    );
    const overview = await loadOverview();
    expect(overview.providers.map((p) => p.key).sort()).toEqual(['oura', 'strava', 'terra']);
  });
});

describe('precedence editor visibility', () => {
  it('is hidden with zero or one active daily-metrics source', async () => {
    await renderPanel([]);
    expect(screen.queryByText('Source precedence')).toBeNull();
    cleanup();
    await renderPanel(['oura']);
    expect(screen.queryByText('Source precedence')).toBeNull();
  });

  it('is shown when more than one daily-metrics source is active, in the configured order', async () => {
    await renderPanel(['terra', 'oura']);
    const editor = screen.getByRole('region', { name: 'Source precedence' });
    const items = within(editor).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Zepp via Terra');
    expect(items[1]).toHaveTextContent('Oura Ring');
  });
});

describe('connect starts the right flow', () => {
  it('OAuth provider: starts that provider and navigates to the returned authorize URL', async () => {
    actions.startConnection.mockResolvedValue({
      ok: true,
      data: { redirectUrl: 'https://cloud.ouraring.com/oauth/authorize?state=s1' },
    });
    await renderPanel(['oura']);
    const card = screen.getByText('Oura Ring').closest('li') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://cloud.ouraring.com/oauth/authorize?state=s1'),
    );
    expect(actions.startConnection).toHaveBeenCalledTimes(1);
    expect(actions.startConnection).toHaveBeenCalledWith('oura');
  });

  it('Terra: starts terra and navigates to the widget URL', async () => {
    actions.startConnection.mockResolvedValue({
      ok: true,
      data: { redirectUrl: 'https://widget.tryterra.co/session/abc' },
    });
    await renderPanel(['oura']);
    const card = screen.getByText('Zepp via Terra').closest('li') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://widget.tryterra.co/session/abc'),
    );
    expect(actions.startConnection).toHaveBeenCalledWith('terra');
  });

  it('a failed start shows the error and does not navigate', async () => {
    actions.startConnection.mockResolvedValue({
      ok: false,
      error: 'Could not start the connection.',
    });
    await renderPanel(['oura']);
    const card = screen.getByText('Strava Rides').closest('li') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(within(card).getByRole('alert')).toHaveTextContent('Could not start the connection.'),
    );
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('disconnect confirmation', () => {
  const openDialog = async () => {
    actions.disconnectProvider.mockResolvedValue({ ok: true });
    await renderPanel(['oura'], [conn('oura', 'daily_metrics_source')]);
    const card = screen.getByText('Oura Ring').closest('li') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Disconnect' }));
    return within(card).getByRole('alertdialog', { name: 'Disconnect Oura Ring' });
  };

  it('states that the history stays, then disconnects that provider without deleting and refreshes', async () => {
    const dialog = await openDialog();
    expect(dialog).toHaveTextContent(/deletes its stored tokens/);
    expect(dialog).toHaveTextContent(/Your history stays/);
    expect(actions.disconnectProvider).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect and keep data' }));
    await waitFor(() => expect(actions.disconnectProvider).toHaveBeenCalledWith('oura', false));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('asks for the erase only when the box is ticked', async () => {
    const dialog = await openDialog();
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: /Also delete the data already synced/ }),
    );
    expect(dialog).toHaveTextContent(/cannot be undone/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect and delete data' }));
    await waitFor(() => expect(actions.disconnectProvider).toHaveBeenCalledWith('oura', true));
  });
});

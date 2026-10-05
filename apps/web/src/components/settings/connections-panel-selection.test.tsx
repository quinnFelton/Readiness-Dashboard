// @vitest-environment jsdom
// Phase 9 settings items: (1) rapid toggles must not drop each other (activeDaily used to be read from
// stale props), (2) a provider that is not connected cannot be selected.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const saveSources = vi.fn();
vi.mock('@/app/settings/_lib/actions', () => ({
  startConnection: vi.fn(),
  disconnectProvider: vi.fn(),
  saveSources: (...a: unknown[]) => saveSources(...a),
}));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import type { ConnectionsOverview } from '@/app/settings/_lib/types';
import { ConnectionsPanel } from './ConnectionsPanel';

const conn = (provider: string, role: string, isActive = true) => ({
  id: `c-${provider}`,
  userId: 'u1',
  provider,
  role,
  externalUserId: null,
  expiresAt: null,
  isActive,
  lastSyncedAt: null,
  connectedAt: '2026-09-01T00:00:00Z',
});

const overview = (
  over: Partial<{
    activitySource: string | null;
    daily: string[];
    connections: ReturnType<typeof conn>[];
  }> = {},
): ConnectionsOverview =>
  ({
    providers: [
      { key: 'oura', role: 'daily_metrics_source', displayName: 'Oura Ring', flow: 'oauth' },
      { key: 'terra', role: 'daily_metrics_source', displayName: 'Zepp via Terra', flow: 'widget' },
      { key: 'strava', role: 'activity_source', displayName: 'Strava', flow: 'oauth' },
    ],
    connections: over.connections ?? [],
    config: { activitySource: over.activitySource ?? null, dailyMetricsSources: over.daily ?? [] },
    precedence: { hrv: ['oura'] },
  }) as unknown as ConnectionsOverview;

beforeEach(() => {
  saveSources.mockReset();
  refresh.mockReset();
});
afterEach(cleanup);

const box = (name: string) => screen.getByRole('checkbox', { name: `Use ${name}` });

describe('rapid toggles', () => {
  it('two quick selections are saved in order and the second includes the first', async () => {
    // The first save is still in flight when the second click lands, and the page has not refreshed
    // yet (props unchanged): the second selection must build on the first, not on stale props.
    let finishFirst!: () => void;
    saveSources
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            finishFirst = () => r({ ok: true });
          }),
      )
      .mockResolvedValue({ ok: true });
    render(
      <ConnectionsPanel
        overview={overview({
          connections: [
            conn('oura', 'daily_metrics_source'),
            conn('terra', 'daily_metrics_source'),
          ],
        })}
      />,
    );
    fireEvent.click(box('Oura Ring'));
    fireEvent.click(box('Zepp via Terra'));

    // Optimistic UI: both are checked immediately.
    expect(box('Oura Ring')).toBeChecked();
    expect(box('Zepp via Terra')).toBeChecked();
    // Only the first save has started; the second is queued behind it, never racing it.
    await waitFor(() => expect(saveSources).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(saveSources).toHaveBeenCalledTimes(1);
    expect(saveSources).toHaveBeenNthCalledWith(1, { dailyMetricsSources: ['oura'] });

    finishFirst();
    await waitFor(() => expect(saveSources).toHaveBeenCalledTimes(2));
    // The old code sent ['terra'] here (computed from the empty server config), losing 'oura'.
    expect(saveSources).toHaveBeenNthCalledWith(2, { dailyMetricsSources: ['oura', 'terra'] });
  });

  it('unchecking then checking again in a burst ends on the right list', async () => {
    saveSources.mockResolvedValue({ ok: true });
    render(
      <ConnectionsPanel
        overview={overview({
          daily: ['oura', 'terra'],
          connections: [
            conn('oura', 'daily_metrics_source'),
            conn('terra', 'daily_metrics_source'),
          ],
        })}
      />,
    );
    fireEvent.click(box('Oura Ring')); // off
    fireEvent.click(box('Oura Ring')); // on again
    await waitFor(() => expect(saveSources).toHaveBeenCalledTimes(2));
    expect(saveSources).toHaveBeenNthCalledWith(1, { dailyMetricsSources: ['terra'] });
    expect(saveSources).toHaveBeenNthCalledWith(2, { dailyMetricsSources: ['terra', 'oura'] });
  });

  it('a failed save shows the error and rolls the checkboxes back to the server state', async () => {
    saveSources.mockResolvedValue({ ok: false, error: 'Could not save your changes.' });
    render(
      <ConnectionsPanel
        overview={overview({ connections: [conn('oura', 'daily_metrics_source')] })}
      />,
    );
    fireEvent.click(box('Oura Ring'));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not save your changes.'),
    );
    expect(box('Oura Ring')).not.toBeChecked();
  });
});

describe('only connected providers can be selected', () => {
  it('activity radio and daily checkbox are disabled for an unconnected provider', async () => {
    render(<ConnectionsPanel overview={overview()} />);
    expect(screen.getByRole('radio', { name: 'Use Strava' })).toBeDisabled();
    expect(box('Oura Ring')).toBeDisabled();
    // A real click (user-event honours `disabled`, as a browser does; fireEvent would not).
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Use Strava' }));
    await user.click(box('Oura Ring'));
    expect(saveSources).not.toHaveBeenCalled();
  });

  it('enabled once connected; an already-selected provider stays toggleable (deselect) after its connection lapses', () => {
    render(
      <ConnectionsPanel
        overview={overview({
          activitySource: 'strava',
          daily: ['terra'],
          connections: [
            conn('strava', 'activity_source'),
            conn('oura', 'daily_metrics_source'),
            conn('terra', 'daily_metrics_source', false), // lapsed
          ],
        })}
      />,
    );
    expect(screen.getByRole('radio', { name: 'Use Strava' })).toBeEnabled();
    expect(box('Oura Ring')).toBeEnabled();
    expect(box('Zepp via Terra')).toBeEnabled(); // selected, so it can still be switched off
    const daily = screen.getByRole('region', { name: 'Daily metrics sources' });
    expect(within(daily).getByText('Disconnected')).toBeInTheDocument();
  });
});

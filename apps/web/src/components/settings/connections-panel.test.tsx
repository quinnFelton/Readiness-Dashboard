// @vitest-environment jsdom
// NOTE: ConnectionsPanel itself cannot be imported under vitest: it uses the `@/` alias and
// apps/web/vitest.config.ts defines no alias (see docs/reports/6c-test-report.md). These tests
// cover ProviderCard (status, last sync, connect, disconnect confirmation) directly.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeStatus, ProviderCard } from './ProviderCard';

afterEach(cleanup);

const conn = (over = {}) =>
  ({
    id: '1',
    userId: 'u',
    provider: 'oura',
    role: 'daily_metrics_source',
    externalUserId: null,
    expiresAt: null,
    isActive: true,
    lastSyncedAt: null,
    connectedAt: '2026-01-01T00:00:00Z',
    ...over,
  }) as never;

const provider = { key: 'oura', role: 'daily_metrics_source' as const, displayName: 'Oura' };

function card(props: Record<string, unknown> = {}) {
  const onConnect = vi.fn().mockResolvedValue(null);
  const onDisconnect = vi.fn().mockResolvedValue(null);
  render(
    <ProviderCard
      provider={provider}
      selected={false}
      selectControl={{ type: 'checkbox', onChange: () => {} }}
      onConnect={onConnect}
      onDisconnect={onDisconnect}
      {...props}
    />,
  );
  return { onConnect, onDisconnect };
}

describe('describeStatus', () => {
  it('maps connection states', () => {
    const now = Date.parse('2026-06-01T00:00:00Z');
    expect(describeStatus(undefined, now)).toBe('Not connected');
    expect(describeStatus(conn({ isActive: false }), now)).toBe('Disconnected');
    expect(describeStatus(conn({ expiresAt: '2026-05-01T00:00:00Z' }), now)).toMatch(/expired/);
    expect(describeStatus(conn(), now)).toBe('Connected');
  });
});

describe('ProviderCard', () => {
  it('unconnected: shows status and Connect, which invokes onConnect', async () => {
    const { onConnect } = card();
    expect(screen.getByText('Not connected')).toBeTruthy();
    fireEvent.click(screen.getByText('Connect'));
    await waitFor(() => expect(onConnect).toHaveBeenCalledOnce());
  });

  it('connected: shows last-sync placeholder or timestamp', () => {
    card({ connection: conn() });
    expect(screen.getByText(/Connected · Last sync: not yet synced/)).toBeTruthy();
    cleanup();
    card({ connection: conn({ lastSyncedAt: '2026-05-01T12:00:00Z' }) });
    expect(screen.queryByText(/not yet synced/)).toBeNull();
    expect(screen.getByText(/Last sync:/)).toBeTruthy();
  });

  it('shows the error returned by a failed connect', async () => {
    card({ onConnect: vi.fn().mockResolvedValue('Provider down') });
    fireEvent.click(screen.getByText('Connect'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Provider down'));
  });

  it('Cancel on the disconnect dialog does not disconnect', () => {
    const { onDisconnect } = card({ connection: conn() });
    fireEvent.click(screen.getByText('Disconnect'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('shows the error returned by a failed disconnect', async () => {
    card({ connection: conn(), onDisconnect: vi.fn().mockResolvedValue('Nope') });
    fireEvent.click(screen.getByText('Disconnect'));
    fireEvent.click(screen.getByText('Disconnect and delete data'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Nope'));
  });
});

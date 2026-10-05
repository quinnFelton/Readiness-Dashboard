// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrecedenceEditor } from './PrecedenceEditor';
import { ProviderCard } from './ProviderCard';
import { moveSource } from './precedence';

afterEach(cleanup);

describe('moveSource', () => {
  it('swaps neighbours and no-ops at the edges', () => {
    expect(moveSource(['oura', 'terra'], 1, -1)).toEqual(['terra', 'oura']);
    expect(moveSource(['oura', 'terra'], 0, -1)).toEqual(['oura', 'terra']);
  });
});

describe('PrecedenceEditor', () => {
  it('reorders and saves the new order', async () => {
    const onSave = vi.fn().mockResolvedValue(null);
    render(
      <PrecedenceEditor
        order={['oura', 'terra']}
        names={{ oura: 'Oura', terra: 'Zepp' }}
        metrics={['hrv']}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByLabelText('Move Zepp up'));
    fireEvent.click(screen.getByText('Save precedence'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(['terra', 'oura']));
  });
});

describe('ProviderCard disconnect', () => {
  const provider = { key: 'oura', role: 'daily_metrics_source' as const, displayName: 'Oura' };
  const connection = {
    id: '1',
    userId: 'u',
    provider: 'oura',
    role: 'daily_metrics_source' as const,
    externalUserId: null,
    expiresAt: null,
    isActive: true,
    lastSyncedAt: null,
    connectedAt: '2026-01-01T00:00:00Z',
  };

  it('requires confirmation that derived data is deleted', async () => {
    const onDisconnect = vi.fn().mockResolvedValue(null);
    render(
      <ProviderCard
        provider={provider}
        connection={connection}
        selected
        selectControl={{ type: 'checkbox', onChange: () => {} }}
        onConnect={async () => null}
        onDisconnect={onDisconnect}
      />,
    );
    fireEvent.click(screen.getByText('Disconnect'));
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog').textContent).toMatch(/derived from it/);
    fireEvent.click(screen.getByText('Disconnect and delete data'));
    await waitFor(() => expect(onDisconnect).toHaveBeenCalledOnce());
  });
});

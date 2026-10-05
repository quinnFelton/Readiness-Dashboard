'use client';
import type { ProviderConnection } from '@rd/shared-types';
import { useState } from 'react';
import type { RegisteredProvider } from '@/app/settings/_lib/types';

export function describeStatus(c: ProviderConnection | undefined, now = Date.now()): string {
  if (!c) return 'Not connected';
  if (!c.isActive) return 'Disconnected';
  if (c.expiresAt && Date.parse(c.expiresAt) < now) return 'Needs reconnecting (token expired)';
  return 'Connected';
}

export function ProviderCard({
  provider,
  connection,
  selected,
  selectControl,
  onConnect,
  onDisconnect,
}: {
  provider: RegisteredProvider;
  connection?: ProviderConnection;
  selected: boolean;
  /** Radio for activity role, checkbox for daily role. */
  selectControl: {
    type: 'radio' | 'checkbox';
    onChange: (checked: boolean) => void;
    /** Not connected (and not already selected): can't be chosen yet. */
    disabled?: boolean;
  };
  onConnect: () => Promise<string | null>;
  /** `deleteData` is true only when the user ticked the erase box (PLAN §10 flow 8, §12). */
  onDisconnect: (deleteData: boolean) => Promise<string | null>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = connection?.isActive === true;

  async function run(fn: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    const err = await fn();
    setError(err);
    setBusy(false);
    setConfirming(false);
    setDeleteData(false);
  }

  return (
    <li className="rounded-lg border p-4">
      <div className="flex items-center gap-3">
        <input
          type={selectControl.type}
          name={selectControl.type === 'radio' ? 'activity-source' : undefined}
          aria-label={`Use ${provider.displayName}`}
          checked={selected}
          disabled={selectControl.disabled}
          title={selectControl.disabled ? `Connect ${provider.displayName} first` : undefined}
          onChange={(e) => selectControl.onChange(e.target.checked)}
        />
        <div className="flex-1">
          <p className="font-medium">{provider.displayName}</p>
          <p className="text-sm opacity-70">
            {describeStatus(connection)}
            {connected && (
              <>
                {' · Last sync: '}
                {connection?.lastSyncedAt
                  ? new Date(connection.lastSyncedAt).toLocaleString()
                  : 'not yet synced'}
              </>
            )}
          </p>
        </div>
        {!confirming && (
          <button
            type="button"
            disabled={busy}
            onClick={() => (connected ? setConfirming(true) : run(onConnect))}
            className="rounded border px-3 py-1.5 disabled:opacity-40"
          >
            {connected ? 'Disconnect' : busy ? 'Connecting…' : 'Connect'}
          </button>
        )}
      </div>
      {confirming && (
        <div
          role="alertdialog"
          aria-label={`Disconnect ${provider.displayName}`}
          className="mt-3 rounded border border-red-500/50 p-3 text-sm"
        >
          <p>
            Disconnecting {provider.displayName} deletes its stored tokens and stops new data
            arriving. Your history stays, so your trends carry on if you switch devices.
          </p>
          <label className="mt-2 flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={deleteData}
              disabled={busy}
              onChange={(e) => setDeleteData(e.target.checked)}
            />
            <span>
              Also delete the data already synced from {provider.displayName} (metrics and scores).
              This cannot be undone.
            </span>
          </label>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => onDisconnect(deleteData))}
              className="rounded bg-red-600 px-3 py-1.5 text-white disabled:opacity-40"
            >
              {busy
                ? 'Disconnecting…'
                : deleteData
                  ? 'Disconnect and delete data'
                  : 'Disconnect and keep data'}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setDeleteData(false);
              }}
              className="rounded border px-3 py-1.5"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </li>
  );
}

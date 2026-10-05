'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { disconnectProvider, saveSources, startConnection } from '@/app/settings/_lib/actions';
import type { ConnectionsOverview } from '@/app/settings/_lib/types';
import { PrecedenceEditor } from './PrecedenceEditor';
import { ProviderCard } from './ProviderCard';

export function ConnectionsPanel({ overview }: { overview: ConnectionsOverview }) {
  const router = useRouter();
  const { providers, connections, config, precedence } = overview;
  const byKey = new Map(connections.map((c) => [c.provider, c]));
  const names = Object.fromEntries(providers.map((p) => [p.key, p.displayName]));
  const activity = providers.filter((p) => p.role === 'activity_source');
  const daily = providers.filter((p) => p.role === 'daily_metrics_source');

  // The selection the user has made so far, which can be AHEAD of the server's config while saves
  // are in flight. `activeDaily` used to be read straight from props, so two quick toggles both
  // computed their list from the same stale value and the second save silently dropped the first.
  const serverDaily = config.dailyMetricsSources.join('|');
  const [activeDaily, setActiveDaily] = useState(config.dailyMetricsSources);
  const latestDaily = useRef(config.dailyMetricsSources); // always the newest selection, synchronously
  const pending = useRef(0); // saves in flight or queued
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [saveError, setSaveError] = useState<string | null>(null);

  // Adopt the server's value again once nothing of ours is outstanding (e.g. after a refresh, or
  // after a failed save the server value is the truth).
  useEffect(() => {
    if (pending.current === 0) {
      latestDaily.current = config.dailyMetricsSources;
      setActiveDaily(config.dailyMetricsSources);
    }
    // `serverDaily` is the dependency: the array identity changes on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverDaily]);

  if (providers.length === 0) {
    return <p>No data providers are available yet.</p>;
  }

  const connect = (key: string) => async () => {
    const r = await startConnection(key);
    if (!r.ok || !r.data) return r.ok ? 'No redirect URL returned.' : r.error;
    window.location.assign(r.data.redirectUrl); // OAuth redirect or Terra widget URL
    return null;
  };
  const disconnect = (key: string) => async (deleteData: boolean) => {
    const r = await disconnectProvider(key, deleteData);
    if (!r.ok) return r.error;
    router.refresh();
    return null;
  };
  const save = async (input: Parameters<typeof saveSources>[0]) => {
    const r = await saveSources(input);
    if (!r.ok) return r.error;
    router.refresh();
    return null;
  };

  /** Saves run one at a time, in click order, so the last one on the server is the newest selection. */
  const saveDaily = (next: string[]) => {
    pending.current += 1;
    setSaveError(null);
    queue.current = queue.current.then(async () => {
      const err = await save({ dailyMetricsSources: next });
      pending.current -= 1;
      if (err) {
        setSaveError(err);
        if (pending.current === 0) {
          // Roll back to what the server really has.
          latestDaily.current = config.dailyMetricsSources;
          setActiveDaily(config.dailyMetricsSources);
        }
      }
    });
  };
  const toggleDaily = (key: string, on: boolean) => {
    const current = latestDaily.current;
    const next = on ? [...current.filter((k) => k !== key), key] : current.filter((k) => k !== key);
    latestDaily.current = next;
    setActiveDaily(next);
    saveDaily(next);
  };

  const metrics = Object.keys(precedence);
  const isConnected = (key: string) => byKey.get(key)?.isActive === true;

  return (
    <div className="space-y-8">
      <section aria-labelledby="act-h">
        <h2 id="act-h" className="text-lg font-medium">
          Activity source
        </h2>
        <p className="text-sm opacity-70">Choose exactly one source for rides and power data.</p>
        <ul className="mt-3 space-y-3">
          {activity.map((p) => (
            <ProviderCard
              key={p.key}
              provider={p}
              connection={byKey.get(p.key)}
              selected={config.activitySource === p.key}
              selectControl={{
                type: 'radio',
                // Only a connected provider can become the activity source (the API refuses too).
                disabled: !isConnected(p.key) && config.activitySource !== p.key,
                onChange: () => void save({ activitySource: p.key }),
              }}
              onConnect={connect(p.key)}
              onDisconnect={disconnect(p.key)}
            />
          ))}
        </ul>
      </section>

      <section aria-labelledby="daily-h">
        <h2 id="daily-h" className="text-lg font-medium">
          Daily metrics sources
        </h2>
        <p className="text-sm opacity-70">HRV, resting HR and recovery. Use one or more.</p>
        <ul className="mt-3 space-y-3">
          {daily.map((p) => (
            <ProviderCard
              key={p.key}
              provider={p}
              connection={byKey.get(p.key)}
              selected={activeDaily.includes(p.key)}
              selectControl={{
                type: 'checkbox',
                disabled: !isConnected(p.key) && !activeDaily.includes(p.key),
                onChange: (on) => toggleDaily(p.key, on),
              }}
              onConnect={connect(p.key)}
              onDisconnect={disconnect(p.key)}
            />
          ))}
        </ul>
        {saveError && (
          <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
            {saveError}
          </p>
        )}
      </section>

      {activeDaily.length > 1 && (
        <PrecedenceEditor
          order={activeDaily}
          names={names}
          metrics={metrics}
          onSave={(order) => save({ dailyMetricsSources: order })}
        />
      )}
    </div>
  );
}

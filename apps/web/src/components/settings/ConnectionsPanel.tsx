'use client';
import { useRouter } from 'next/navigation';
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

  if (providers.length === 0) {
    return <p>No data providers are available yet.</p>;
  }

  const connect = (key: string) => async () => {
    const r = await startConnection(key);
    if (!r.ok || !r.data) return r.ok ? 'No redirect URL returned.' : r.error;
    window.location.assign(r.data.redirectUrl); // OAuth redirect or Terra widget URL
    return null;
  };
  const disconnect = (key: string) => async () => {
    const r = await disconnectProvider(key);
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

  const activeDaily = config.dailyMetricsSources;
  const metrics = Object.keys(precedence);

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
                onChange: (on) =>
                  void save({
                    dailyMetricsSources: on
                      ? [...activeDaily, p.key]
                      : activeDaily.filter((k) => k !== p.key),
                  }),
              }}
              onConnect={connect(p.key)}
              onDisconnect={disconnect(p.key)}
            />
          ))}
        </ul>
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

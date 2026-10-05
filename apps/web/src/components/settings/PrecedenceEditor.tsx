'use client';
import { useState } from 'react';
import { moveSource } from './precedence';

const METRIC_LABELS: Record<string, string> = {
  hrv: 'HRV',
  resting_hr: 'Resting HR',
  sleep_score: 'Sleep score',
  readiness: 'Readiness',
};

// PLAN §6: explicit per-metric precedence. The API currently stores ONE ordering
// (connection_configs priority) that applies to every metric, so the editor reorders that
// shared list and previews the result per metric.
export function PrecedenceEditor({
  order,
  names,
  metrics,
  onSave,
}: {
  order: string[];
  names: Record<string, string>;
  metrics: string[];
  onSave: (order: string[]) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState(order);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = draft.join() !== order.join();
  const label = (k: string) => names[k] ?? k;

  return (
    <section aria-labelledby="prec-h" className="rounded-lg border p-4">
      <h3 id="prec-h" className="font-medium">
        Source precedence
      </h3>
      <p className="mt-1 text-sm opacity-70">
        When several sources report the same metric on the same day, the highest-ranked source wins.
        Oura is preferred by default.
      </p>
      <ol className="mt-3 space-y-2">
        {draft.map((key, i) => (
          <li key={key} className="flex items-center gap-2">
            <span className="w-6 text-sm opacity-60">{i + 1}.</span>
            <span className="flex-1">{label(key)}</span>
            <button
              type="button"
              aria-label={`Move ${label(key)} up`}
              disabled={i === 0}
              onClick={() => setDraft(moveSource(draft, i, -1))}
              className="rounded border px-2 py-1 disabled:opacity-40"
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={`Move ${label(key)} down`}
              disabled={i === draft.length - 1}
              onClick={() => setDraft(moveSource(draft, i, 1))}
              className="rounded border px-2 py-1 disabled:opacity-40"
            >
              ↓
            </button>
          </li>
        ))}
      </ol>
      <dl className="mt-3 grid grid-cols-2 gap-1 text-sm opacity-80">
        {metrics.map((m) => (
          <div key={m} className="contents">
            <dt>{METRIC_LABELS[m] ?? m}</dt>
            <dd>{draft.map(label).join(' › ')}</dd>
          </div>
        ))}
      </dl>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={!dirty || saving}
        onClick={async () => {
          setSaving(true);
          setError(await onSave(draft));
          setSaving(false);
        }}
        className="mt-3 rounded bg-slate-900 px-3 py-1.5 text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
      >
        {saving ? 'Saving…' : 'Save precedence'}
      </button>
    </section>
  );
}

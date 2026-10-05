import Link from 'next/link';
import { PromoteButton } from './PromoteButton';
import { RANGES, type ClassifierComparisonRow, type DeriverRow, type Range } from './types';

export const DefaultBadge = () => (
  <span className="ml-2 rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/40 dark:text-blue-200">
    default
  </span>
);

export const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);

export function RangeSelector({ range }: { range: Range }) {
  return (
    <nav aria-label="Date range" className="flex gap-2 text-sm">
      {RANGES.map((r) => (
        <Link
          key={r}
          href={`/admin/classifiers?range=${r}`}
          aria-current={r === range ? 'page' : undefined}
          className={`rounded border px-2 py-1 ${r === range ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : ''}`}
        >
          {r}
        </Link>
      ))}
    </nav>
  );
}

export function ClassifierTable({
  rows,
  promote,
}: {
  rows: ClassifierComparisonRow[];
  promote: (formData: FormData) => Promise<void>;
}) {
  if (rows.length === 0) return <p role="status">No classifiers registered.</p>;
  const defaultRow = rows.find((r) => r.isDefault);
  return (
    <table className="w-full text-sm">
      <thead className="border-b text-left text-slate-600 dark:text-slate-300">
        <tr>
          <th className="px-3 py-2">Classifier</th>
          <th className="px-3 py-2">Votes ▲/▼</th>
          <th className="px-3 py-2">Agreement</th>
          <th className="px-3 py-2">Hits</th>
          <th className="px-3 py-2">Misses</th>
          <th className="px-3 py-2">False alarms</th>
          <th className="px-3 py-2">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b last:border-0">
            <td className="px-3 py-2">
              <code>{r.id}</code>
              {r.isDefault && <DefaultBadge />}
              {r.description && <div className="text-xs text-slate-500">{r.description}</div>}
            </td>
            <td className="px-3 py-2">
              {r.votesUp} / {r.votesDown}
            </td>
            <td className="px-3 py-2">{pct(r.agreementRate)}</td>
            <td className="px-3 py-2">{r.backtest.hits}</td>
            <td className="px-3 py-2">{r.backtest.misses}</td>
            <td className="px-3 py-2">{r.backtest.falseAlarms}</td>
            <td className="px-3 py-2">
              {!r.isDefault && (
                <PromoteButton
                  classifierId={r.id}
                  currentDefaultId={defaultRow?.id ?? null}
                  action={promote}
                />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DeriverList({ rows }: { rows: DeriverRow[] }) {
  if (rows.length === 0) return <p role="status">No derivers registered.</p>;
  return (
    <ul className="divide-y rounded border">
      {rows.map((d) => (
        <li key={d.id} className="px-3 py-2">
          <code>{d.id}</code>
          {d.isDefault && <DefaultBadge />}
          {d.description && <span className="ml-2 text-sm text-slate-500">{d.description}</span>}
        </li>
      ))}
    </ul>
  );
}

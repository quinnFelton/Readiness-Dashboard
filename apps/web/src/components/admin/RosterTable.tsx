import Link from 'next/link';
import { formatSync, sortRoster, STATE_LABEL, type SortDir, type SortKey } from './roster';
import type { RosterRow } from './types';

const BADGE: Record<string, string> = {
  overreaching_risk: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  acute_fatigue: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  fitness_gain: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  ambiguous: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
};

function Th({
  k,
  cur,
  dir,
  children,
}: {
  k: SortKey;
  cur: SortKey;
  dir: SortDir;
  children: string;
}) {
  const next = cur === k && dir === 'asc' ? 'desc' : 'asc';
  const arrow = cur === k ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
  return (
    <th
      scope="col"
      className="px-3 py-2 text-left font-medium"
      aria-sort={cur === k ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <Link href={`/admin?sort=${k}&dir=${next}`} className="hover:underline">
        {children}
        {arrow}
      </Link>
    </th>
  );
}

export function RosterTable({
  rows,
  sort,
  dir,
  now,
}: {
  rows: RosterRow[];
  sort: SortKey;
  dir: SortDir;
  now?: number;
}) {
  if (rows.length === 0) {
    return (
      <p role="status" className="rounded border p-6 text-slate-600 dark:text-slate-300">
        No athletes yet. Users appear here once they sign up.
      </p>
    );
  }
  const sorted = sortRoster(rows, sort, dir);
  return (
    <table className="w-full text-sm">
      <thead className="border-b text-slate-600 dark:text-slate-300">
        <tr>
          <Th k="name" cur={sort} dir={dir}>
            Athlete
          </Th>
          <th scope="col" className="px-3 py-2 text-left font-medium">
            Sources
          </th>
          <Th k="state" cur={sort} dir={dir}>
            Latest state
          </Th>
          <Th k="lastSync" cur={sort} dir={dir}>
            Last sync
          </Th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr key={r.id} className="border-b last:border-0">
            <td className="px-3 py-2">
              <Link href={`/admin/athletes/${r.id}`} className="font-medium hover:underline">
                {r.name ?? r.email}
              </Link>
              {r.name && <div className="text-xs text-slate-500">{r.email}</div>}
            </td>
            <td className="px-3 py-2">
              {r.connections.length === 0 ? (
                <span className="text-slate-500">None connected</span>
              ) : (
                r.connections.map((c) => c.provider).join(', ')
              )}
            </td>
            <td className="px-3 py-2">
              {r.latestState ? (
                <span
                  className={`rounded px-2 py-0.5 text-xs font-medium ${BADGE[r.latestState] ?? BADGE.ambiguous}`}
                >
                  {STATE_LABEL[r.latestState] ?? r.latestState}
                </span>
              ) : (
                <span className="text-slate-500">No data yet</span>
              )}
            </td>
            <td className="px-3 py-2">{formatSync(r.lastSyncAt, now)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

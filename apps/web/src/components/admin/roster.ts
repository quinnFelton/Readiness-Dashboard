import type { RosterRow } from './types';

export type SortKey = 'name' | 'state' | 'lastSync';
export type SortDir = 'asc' | 'desc';

export function parseSort(key?: string, dir?: string): { key: SortKey; dir: SortDir } {
  const k: SortKey = key === 'name' || key === 'lastSync' || key === 'state' ? key : 'state';
  return { key: k, dir: dir === 'desc' ? 'desc' : 'asc' };
}

// Triage order for a coach: overreaching first (PLAN §8.3 headline case), then acute fatigue,
// ambiguous, fitness gain; users with no state yet sink to the bottom.
const STATE_RANK: Record<string, number> = {
  overreaching_risk: 0,
  acute_fatigue: 1,
  ambiguous: 2,
  fitness_gain: 3,
};
const rank = (s: string | null) => (s == null ? 99 : (STATE_RANK[s] ?? 50));
const label = (r: RosterRow) => (r.name ?? r.email).toLowerCase();

/** Stable sort; overreaching_risk rows are pinned first regardless of key/direction. */
export function sortRoster(rows: RosterRow[], key: SortKey, dir: SortDir): RosterRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  const cmp = (a: RosterRow, b: RosterRow): number => {
    const pa = a.latestState === 'overreaching_risk' ? 0 : 1;
    const pb = b.latestState === 'overreaching_risk' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    let c: number;
    if (key === 'name') c = label(a).localeCompare(label(b));
    else if (key === 'state') c = rank(a.latestState) - rank(b.latestState);
    else {
      // never-synced users always last, whichever direction
      if (!a.lastSyncAt || !b.lastSyncAt) return a.lastSyncAt ? -1 : b.lastSyncAt ? 1 : 0;
      c = Date.parse(a.lastSyncAt) - Date.parse(b.lastSyncAt);
    }
    return c !== 0 ? c * sign : label(a).localeCompare(label(b));
  };
  return [...rows].sort(cmp);
}

export const STATE_LABEL: Record<string, string> = {
  overreaching_risk: 'Overreaching risk',
  acute_fatigue: 'Acute fatigue',
  fitness_gain: 'Fitness gain',
  ambiguous: 'Ambiguous',
};

export function formatSync(iso: string | null, now = Date.now()): string {
  if (!iso) return 'Never';
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 48) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

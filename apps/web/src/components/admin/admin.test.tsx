// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminNavLink } from './AdminNavLink';
import { ClassifierSwitch } from './ClassifierSwitch';
import { ClassifierTable, DeriverList } from './ClassifierTable';
import { RosterTable } from './RosterTable';
import { formatSync, parseSort, sortRoster } from './roster';
import { parseRange, type ClassifierComparisonRow, type RosterRow } from './types';

afterEach(cleanup);

const row = (id: string, o: Partial<RosterRow> = {}): RosterRow => ({
  id,
  name: id,
  email: `${id}@x.org`,
  connections: [],
  latestState: null,
  latestStateAsOf: null,
  lastSyncAt: null,
  ...o,
});

describe('sortRoster', () => {
  const rows = [
    row('zed', { latestState: 'fitness_gain', lastSyncAt: '2026-10-03T00:00:00Z' }),
    row('amy', { latestState: 'acute_fatigue', lastSyncAt: '2026-10-01T00:00:00Z' }),
    row('bob', { latestState: 'overreaching_risk', lastSyncAt: '2026-09-01T00:00:00Z' }),
    row('cat'),
  ];
  it('pins overreaching_risk first for every key and direction', () => {
    for (const key of ['name', 'state', 'lastSync'] as const) {
      for (const dir of ['asc', 'desc'] as const) {
        expect(sortRoster(rows, key, dir)[0]!.id).toBe('bob');
      }
    }
  });
  it('default state sort ranks fatigue before gain and no-data last', () => {
    expect(sortRoster(rows, 'state', 'asc').map((r) => r.id)).toEqual(['bob', 'amy', 'zed', 'cat']);
  });
  it('sorts by name and keeps never-synced last by last sync', () => {
    expect(sortRoster(rows, 'name', 'desc').map((r) => r.id)).toEqual(['bob', 'zed', 'cat', 'amy']);
    expect(sortRoster(rows, 'lastSync', 'desc').at(-1)!.id).toBe('cat');
  });
  it('does not mutate input; parseSort/parseRange sanitize', () => {
    const copy = [...rows];
    sortRoster(rows, 'name', 'asc');
    expect(rows).toEqual(copy);
    expect(parseSort('bogus', 'x')).toEqual({ key: 'state', dir: 'asc' });
    expect(parseRange('7d')).toBe('90d');
  });
  it('formats sync times', () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    expect(formatSync(null, now)).toBe('Never');
    expect(formatSync('2026-10-04T11:30:00Z', now)).toBe('30m ago');
    expect(formatSync('2026-10-01T12:00:00Z', now)).toBe('3d ago');
  });
});

describe('RosterTable', () => {
  it('shows empty state', () => {
    render(<RosterTable rows={[]} sort="state" dir="asc" />);
    expect(screen.getByRole('status').textContent).toMatch(/No athletes yet/);
  });
  it('lists overreaching athlete first with links and fallbacks', () => {
    render(
      <RosterTable
        rows={[
          row('amy'),
          row('bob', {
            latestState: 'overreaching_risk',
            connections: [{ provider: 'oura', role: 'daily_metrics_source' }],
          }),
        ]}
        sort="name"
        dir="asc"
      />,
    );
    const links = screen
      .getAllByRole('link')
      .filter((l) => l.getAttribute('href')?.startsWith('/admin/athletes/'));
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/admin/athletes/bob',
      '/admin/athletes/amy',
    ]);
    expect(screen.getByText('Overreaching risk')).toBeTruthy();
    expect(screen.getByText('None connected')).toBeTruthy();
    expect(screen.getByText('No data yet')).toBeTruthy();
  });
});

const classifiers: ClassifierComparisonRow[] = [
  {
    id: 'ef_quadrant_v1',
    isDefault: true,
    votesUp: 5,
    votesDown: 1,
    agreementRate: 0.83,
    backtest: { hits: 3, misses: 1, falseAlarms: 2 },
  },
  {
    id: 'alt_v2',
    isDefault: false,
    votesUp: 2,
    votesDown: 4,
    agreementRate: null,
    backtest: { hits: 1, misses: 3, falseAlarms: 0 },
  },
];

describe('ClassifierTable', () => {
  it('renders metrics, default badge, and promote only for non-default', () => {
    render(<ClassifierTable rows={classifiers} promote={async () => {}} />);
    expect(screen.getByText('83%')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getAllByText('default')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Make default' })).toHaveLength(1);
  });
  it('confirmation text names both classifiers and the user-visible effect', () => {
    render(<ClassifierTable rows={classifiers} promote={async () => {}} />);
    const dialog = document.querySelector('dialog')!;
    expect(dialog.textContent).toMatch(/alt_v2/);
    expect(dialog.textContent).toMatch(/instead of ef_quadrant_v1/);
    expect(dialog.textContent).toMatch(/Every athlete/);
  });
  it('lists derivers with default badge', () => {
    render(
      <DeriverList
        rows={[
          { id: 'peak20_v1', isDefault: true },
          { id: 'np_v1', isDefault: false },
        ]}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getAllByText('default')).toHaveLength(1);
  });
});

describe('ClassifierSwitch', () => {
  it('shows no warning for the default', () => {
    render(<ClassifierSwitch classifiers={classifiers} selected={null} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('warns when a non-default classifier is selected', () => {
    render(<ClassifierSwitch classifiers={classifiers} selected="alt_v2" />);
    expect(screen.getByRole('alert').textContent).toMatch(/non-default classifier alt_v2/);
  });
});

describe('AdminNavLink', () => {
  it('renders only for master (convenience; enforcement is server-side)', () => {
    const { container, rerender } = render(<AdminNavLink role="user" />);
    expect(container.textContent).toBe('');
    rerender(<AdminNavLink role="master" />);
    expect(screen.getByRole('link', { name: 'Admin' })).toBeTruthy();
  });
});

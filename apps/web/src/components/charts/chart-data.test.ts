import { describe, expect, it } from 'vitest';
import {
  buildChartRows,
  dateToTs,
  needsDots,
  resolveAxes,
  timeDomain,
  type ChartSeries,
} from './chart-data';

const s = (key: string, dates: string[], extra: Partial<ChartSeries> = {}): ChartSeries => ({
  key,
  label: key,
  color: '#000',
  points: dates.map((date, i) => ({ date, value: i + 1 })),
  ...extra,
});

describe('buildChartRows', () => {
  it('merges series onto one sorted timeline', () => {
    const rows = buildChartRows([s('a', ['2026-01-02', '2026-01-01']), s('b', ['2026-01-02'])]);
    expect(rows.map((r) => r.ts)).toEqual([dateToTs('2026-01-01'), dateToTs('2026-01-02')]);
    expect(rows[1]).toMatchObject({ a: 1, b: 1 });
    expect(rows[0]?.b).toBeUndefined();
  });

  it('inserts a null break row across rest days instead of interpolating', () => {
    const rows = buildChartRows([s('ef', ['2026-01-01', '2026-01-05'])]);
    const brk = rows.find((r) => r.ts === dateToTs('2026-01-02'));
    expect(brk?.ef).toBeNull();
    expect(rows).toHaveLength(3);
  });

  it('keeps adjacent days connected and honours a wider maxGapDays', () => {
    expect(buildChartRows([s('hrv', ['2026-01-01', '2026-01-02'])])).toHaveLength(2);
    expect(buildChartRows([s('ef', ['2026-01-01', '2026-01-03'], { maxGapDays: 2 })])).toHaveLength(
      2,
    );
  });

  it('drops non-finite values and rejects malformed dates', () => {
    const series = s('a', ['2026-01-01']);
    series.points.push({ date: '2026-01-02', value: Number.NaN });
    expect(buildChartRows([series])).toHaveLength(1);
    expect(() => buildChartRows([s('a', ['nope'])])).toThrow(RangeError);
  });
});

describe('helpers', () => {
  it('needsDots: sparse or tiny series get dots, long daily series do not', () => {
    expect(needsDots(s('a', ['2026-01-01']))).toBe(true);
    const dense = s(
      'a',
      Array.from({ length: 20 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`),
    );
    expect(needsDots(dense)).toBe(false);
    expect(needsDots({ ...dense, maxGapDays: 3 })).toBe(true);
  });

  it('timeDomain spans rows, bands and markers; null when empty', () => {
    expect(timeDomain([])).toBeNull();
    const rows = buildChartRows([s('a', ['2026-01-05'])]);
    const d = timeDomain(
      rows,
      [{ start: '2026-01-01', end: '2026-01-03', color: '#f00', label: 'x' }],
      [{ date: '2026-01-09', label: 'e', color: '#0f0' }],
    );
    expect(d).toEqual([dateToTs('2026-01-01'), dateToTs('2026-01-09')]);
  });

  it('resolveAxes: first left, second right, rest hidden', () => {
    const axes = resolveAxes([
      s('a', [], { axis: 'ef' }),
      s('b', [], { axis: 'hrv' }),
      s('c', [], { axis: 'rhr' }),
      s('d', [], { axis: 'ef' }),
    ]);
    expect(axes.map((a) => [a.id, a.orientation, a.hide])).toEqual([
      ['ef', 'left', false],
      ['hrv', 'right', false],
      ['rhr', 'left', true],
    ]);
  });
});

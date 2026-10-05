// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Recharts' ResponsiveContainer needs layout; the legend is plain HTML below the plot, which is
// what is under test.
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});

import { TimeSeriesChart } from './TimeSeriesChart';

afterEach(cleanup);

const s = (key: string, label: string, n: number) => ({
  key,
  label,
  color: '#123456',
  kind: 'line' as const,
  axis: 'left' as const,
  points: Array.from({ length: n }, (_, i) => ({ date: `2026-03-0${i + 1}`, value: 1 + i })),
});

describe('TimeSeriesChart legend', () => {
  it('lists only the series that have points', () => {
    render(
      <TimeSeriesChart
        title="EF vs recovery"
        series={[s('ef', 'EF (peak-20)', 3), s('hrv', 'HRV', 0), s('rhr', 'Resting HR', 0)]}
      />,
    );
    const legend = screen.getByRole('figure').querySelector('figcaption')!;
    expect(legend).toHaveTextContent('EF (peak-20)');
    expect(legend).not.toHaveTextContent('HRV');
    expect(legend).not.toHaveTextContent('Resting HR');
  });

  it('lists every series once each has data', () => {
    render(
      <TimeSeriesChart
        title="EF vs recovery"
        series={[s('ef', 'EF (peak-20)', 3), s('hrv', 'HRV', 2), s('rhr', 'Resting HR', 1)]}
      />,
    );
    const legend = screen.getByRole('figure').querySelector('figcaption')!;
    for (const label of ['EF (peak-20)', 'HRV', 'Resting HR'])
      expect(legend).toHaveTextContent(label);
  });

  it('shows the empty message, and no legend at all, when nothing has points', () => {
    render(
      <TimeSeriesChart
        title="t"
        series={[s('ef', 'EF', 0), s('hrv', 'HRV', 0)]}
        emptyMessage="Nothing yet"
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Nothing yet');
    expect(screen.queryByRole('figure')).toBeNull();
  });
});

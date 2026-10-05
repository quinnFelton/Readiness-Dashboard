// Per-metric breakdown with 7d vs 28d context and a rating widget for each flagged state.
import { submitVote } from '../../app/dashboard/actions';
import { TimeSeriesChart } from '../charts';
import { InsightRating } from './InsightRating';
import { loadDashboardData } from './load';
import {
  METRIC_COLORS,
  extractStateHistory,
  findVote,
  hasAnyData,
  latestDate,
  summarizeMetric,
} from './model';
import { Card, EmptyState, ErrorPanel, StateBadge } from './panels';
import { isFlagged } from './state-meta';
import type { MetricSeries, TrendRow } from '@rd/shared-types';

export interface AthleteTrendsProps {
  userId: string;
  viewerId: string;
  isSelf?: boolean;
}

interface MetricSpec {
  seriesKey: keyof MetricSeries;
  trendType: TrendRow['metricType'];
  title: string;
  unit: string;
  color: string;
  sparse: boolean;
  hint: string;
}

const METRICS: MetricSpec[] = [
  {
    seriesKey: 'efPeak20',
    trendType: 'ef_peak20',
    title: 'EF peak-20',
    unit: 'W/bpm',
    color: METRIC_COLORS.efPeak20,
    sparse: true,
    hint: 'Higher is better. Primary signal, best sustained 20-minute effort.',
  },
  {
    seriesKey: 'efOverall',
    trendType: 'ef_overall',
    title: 'EF overall',
    unit: 'W/bpm',
    color: METRIC_COLORS.efOverall,
    sparse: true,
    hint: 'Higher is better. Noisier, but covers easier rides too.',
  },
  {
    seriesKey: 'hrv',
    trendType: 'hrv',
    title: 'HRV',
    unit: 'ms',
    color: METRIC_COLORS.hrv,
    sparse: false,
    hint: 'Higher usually means better recovered.',
  },
  {
    seriesKey: 'restingHr',
    trendType: 'resting_hr',
    title: 'Resting HR',
    unit: 'bpm',
    color: METRIC_COLORS.restingHr,
    sparse: false,
    hint: 'Lower usually means better recovered.',
  },
];

const fmt = (n: number | null, digits = 2) => (n === null ? '–' : n.toFixed(digits));

export async function AthleteTrends({
  userId,
  viewerId,
  isSelf = userId === viewerId,
}: AthleteTrendsProps) {
  const result = await loadDashboardData(userId);
  if (!result.ok) return <ErrorPanel message={result.message} onRetryHref="/dashboard/trends" />;

  const { trends, feedback } = result.data;
  const history = extractStateHistory(trends.trends);
  if (!hasAnyData(trends.series, history)) return <EmptyState isSelf={isSelf} />;
  const end = latestDate(trends.series, history) as string;
  const flagged = history
    .filter((h) => isFlagged(h.state))
    .slice(-10)
    .reverse();

  return (
    <div className="space-y-6">
      {METRICS.map((m) => {
        const points = trends.series[m.seriesKey];
        const windows = summarizeMetric(points, trends.trends, m.trendType, end);
        return (
          <Card key={m.seriesKey} title={m.title} id={`metric-${m.seriesKey}`}>
            <p className="text-sm text-slate-500 dark:text-slate-400">{m.hint}</p>
            <table className="mt-3 w-full text-left text-sm">
              <caption className="sr-only">{m.title}: 7-day versus 28-day context</caption>
              <thead>
                <tr className="text-slate-500 dark:text-slate-400">
                  <th scope="col" className="py-1 font-medium">
                    Window
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Mean ({m.unit})
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Readings
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    z-score
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Direction
                  </th>
                </tr>
              </thead>
              <tbody>
                {windows.map((w) => (
                  <tr key={w.window}>
                    <th scope="row" className="py-1 font-medium">
                      {w.window}
                    </th>
                    <td>{fmt(w.mean)}</td>
                    <td>{w.count}</td>
                    <td>{fmt(w.zScore, 1)}</td>
                    <td>{w.direction ?? '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <TimeSeriesChart
              title={`${m.title} over time`}
              height={180}
              showLegend={false}
              emptyMessage={`No ${m.title} readings yet.`}
              series={[
                {
                  key: m.seriesKey,
                  label: m.title,
                  unit: m.unit,
                  color: m.color,
                  points,
                  showDots: m.sparse ? true : undefined,
                },
              ]}
            />
          </Card>
        );
      })}

      <Card title="Flagged states" id="flagged-heading">
        {flagged.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Nothing flagged in this period.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-700">
            {flagged.map((f) => (
              <li key={`${f.classifierId}-${f.asOf}`} className="py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <StateBadge state={f.state} />
                  <span className="text-sm text-slate-500 dark:text-slate-400">{f.asOf}</span>
                </div>
                {f.insightText && <p className="mt-2 text-sm">{f.insightText}</p>}
                <InsightRating
                  classifierId={f.classifierId}
                  asOf={f.asOf}
                  label={`${f.state} flag, ${f.asOf}`}
                  current={findVote(feedback, f.classifierId, f.asOf, viewerId)}
                  onVote={submitVote.bind(null, userId)}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

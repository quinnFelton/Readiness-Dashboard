// Reusable per-athlete dashboard (PLAN §9). Takes a userId so phase 6b's admin drill-down can
// render the identical view; ratings and the event log live in here so a coach gets them too.
// Server Component: all fetching happens server-side via the typed client in ./api.
import Link from 'next/link';
import { logEvent, removeEvent, submitVote } from '../../app/dashboard/actions';
import { TimeSeriesChart } from '../charts';
import { EventLog } from './EventLog';
import { InsightRating } from './InsightRating';
import { loadDashboardData } from './load';
import {
  METRIC_COLORS,
  currentState,
  eventMarkers,
  extractStateHistory,
  findVote,
  hasAnyData,
  heroSeries,
  latestDate,
  rangeStart,
  statesToBands,
} from './model';
import { Card, EmptyState, ErrorPanel, StateBadge } from './panels';
import { STATE_META, isStateId } from './state-meta';

export interface AthleteDashboardProps {
  /** Athlete whose data is shown. */
  userId: string;
  /** The signed-in viewer (self or a master); votes are attributed to them. */
  viewerId: string;
  /** Where "see metric breakdown" points; the admin drill-down overrides this. */
  trendsHref?: string;
  /** Controls the empty-state wording: a new user is sent to /settings/connections. */
  isSelf?: boolean;
  /** Master drill-down only (PLAN §8.7): load this classifier's rows instead of the default. */
  classifier?: string | null;
}

const CHART_DAYS = 90;

export async function AthleteDashboard({
  userId,
  viewerId,
  trendsHref = '/dashboard/trends',
  isSelf = userId === viewerId,
  classifier = null,
}: AthleteDashboardProps) {
  const result = await loadDashboardData(userId, classifier ? { classifier } : undefined);
  if (!result.ok) return <ErrorPanel message={result.message} onRetryHref="/dashboard" />;

  const { trends, scores, feedback, events } = result.data;
  const history = extractStateHistory(trends.trends);
  if (!hasAnyData(trends.series, history)) return <EmptyState isSelf={isSelf} />;

  const end = latestDate(trends.series, history) as string; // non-null: hasAnyData
  const from = rangeStart(end, CHART_DAYS);
  const inRange = <T extends { date: string }>(pts: T[]) => pts.filter((p) => p.date >= from);
  const series = heroSeries({
    efPeak20: inRange(trends.series.efPeak20),
    efOverall: inRange(trends.series.efOverall),
    hrv: inRange(trends.series.hrv),
    restingHr: inRange(trends.series.restingHr),
  });
  const bands = statesToBands(
    history.filter((h) => h.asOf >= from),
    end,
  );
  const markers = eventMarkers(events, from);

  const now = currentState(history);
  const meta = now && isStateId(now.state) ? STATE_META[now.state] : null;
  const vote = now ? findVote(feedback, now.classifierId, now.asOf, viewerId) : null;
  const latestScore = scores[scores.length - 1];
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      <Card title="Current state" id="hero-heading">
        {now ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <StateBadge state={now.state} />
              <span className="text-sm text-slate-500 dark:text-slate-400">
                since {now.since} · as of {now.asOf}
              </span>
            </div>
            <p className="mt-3">{now.insightText ?? meta?.summary}</p>
            {now.state !== 'insufficient_data' && (
              <InsightRating
                classifierId={now.classifierId}
                asOf={now.asOf}
                label={`current state, ${now.asOf}`}
                current={vote}
                onVote={submitVote.bind(null, userId)}
              />
            )}
          </>
        ) : (
          <p className="text-slate-600 dark:text-slate-300">
            No classification yet. We need both efficiency and recovery data for the same period.
          </p>
        )}
        <Link
          href={trendsHref}
          className="mt-3 inline-block text-sm text-blue-700 underline dark:text-blue-400"
        >
          See the metric breakdown
        </Link>
      </Card>

      <Card title="EF peak-20 vs recovery" id="hero-chart-heading">
        <TimeSeriesChart
          title="EF peak-20 against HRV and resting HR, with fatigue and fitness periods shaded"
          series={series}
          bands={bands}
          markers={markers}
          emptyMessage="No efficiency or recovery readings in the last 90 days."
        />
        {bands.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Period colors">
            {[...new Map(bands.map((b) => [b.label, b.color])).entries()].map(([label, color]) => (
              <li key={label} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ backgroundColor: color, opacity: 0.6 }}
                />
                {label}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {latestScore && (
        <Card title="Readiness score" id="readiness-heading">
          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-semibold">{Math.round(latestScore.score)}</span>
            <span className="text-sm text-slate-500 dark:text-slate-400">
              as of {latestScore.date} · a simple blend of recovery metrics, secondary to the state
              above
            </span>
          </div>
          <TimeSeriesChart
            title="Readiness score, last 28 days"
            height={120}
            showLegend={false}
            series={[
              {
                key: 'score',
                label: 'Readiness',
                color: METRIC_COLORS.readiness,
                kind: 'area',
                points: scores.map((s) => ({ date: s.date, value: s.score })),
              },
            ]}
          />
        </Card>
      )}

      {result.data.eventsFailed ? (
        <ErrorPanel message="The event log could not be loaded." />
      ) : (
        <EventLog
          events={events}
          today={today}
          onCreate={logEvent.bind(null, userId)}
          onDelete={removeEvent.bind(null, userId)}
        />
      )}
    </div>
  );
}

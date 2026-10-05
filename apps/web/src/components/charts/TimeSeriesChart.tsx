'use client';

// The one shared, parameterized chart (PLAN §9): line/area series, optional dual axes,
// colored state bands (quadrant periods, §8.3) and event markers. Sparse-data safe via
// buildChartRows (no interpolation across rest days).
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  buildChartRows,
  dateToTs,
  needsDots,
  resolveAxes,
  timeDomain,
  tsToDate,
  type ChartBand,
  type ChartMarker,
  type ChartSeries,
} from './chart-data';

export interface TimeSeriesChartProps {
  series: ChartSeries[];
  bands?: ChartBand[];
  markers?: ChartMarker[];
  height?: number;
  /** Accessible name; also read by screen readers since SVG charts are otherwise opaque. */
  title: string;
  /** Shown instead of the plot when no series has any point. */
  emptyMessage?: string;
  showLegend?: boolean;
}

// currentColor + opacity keeps axes/grid legible in both light and dark mode.
const AXIS_STYLE = { fontSize: 11, fill: 'currentColor', opacity: 0.7 } as const;

interface TooltipPayloadItem {
  dataKey?: string | number;
  value?: number | null;
  color?: string;
  name?: string;
}

function ChartTooltip({
  active,
  payload,
  label,
  series,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: number;
  series: ChartSeries[];
}) {
  if (!active || !payload || label === undefined) return null;
  const items = payload.filter((p) => typeof p.value === 'number');
  if (items.length === 0) return null;
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
      <div className="mb-1 font-medium">{tsToDate(label)}</div>
      {items.map((p) => {
        const s = series.find((x) => x.key === p.dataKey);
        return (
          <div key={String(p.dataKey)} className="flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: p.color }}
            />
            <span>
              {s?.label ?? p.name}: {Number(p.value).toFixed(2)}
              {s?.unit ? ` ${s.unit}` : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function TimeSeriesChart({
  series: allSeries,
  bands = [],
  markers = [],
  height = 320,
  title,
  emptyMessage = 'No data in this range yet.',
  showLegend = true,
}: TimeSeriesChartProps) {
  // Only series that have points are plotted AND listed in the legend (phase 9 dashboard item: the
  // hero chart's legend used to name HRV / resting HR even when nothing was drawn for them, and an
  // empty series on its own axis drew an empty axis).
  const series = allSeries.filter((s) => s.points.length > 0);
  const hasData = series.length > 0;
  if (!hasData) {
    return (
      <p role="status" className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
        {emptyMessage}
      </p>
    );
  }

  const rows = buildChartRows(series);
  const axes = resolveAxes(series);
  const domain = timeDomain(rows, bands, markers) ?? ['auto', 'auto'];

  return (
    <figure aria-label={title} className="text-slate-700 dark:text-slate-200">
      <div style={{ width: '100%', height }}>
        <ResponsiveContainer>
          <ComposedChart data={rows} margin={{ top: 16, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="currentColor" strokeOpacity={0.12} vertical={false} />
            <XAxis
              dataKey="ts"
              type="number"
              scale="time"
              domain={domain}
              tickFormatter={(v: number) => tsToDate(v).slice(5)}
              tick={AXIS_STYLE}
              stroke="currentColor"
              strokeOpacity={0.3}
            />
            {axes.map((a) => (
              <YAxis
                key={a.id}
                yAxisId={a.id}
                orientation={a.orientation}
                hide={a.hide}
                domain={['auto', 'auto']}
                tick={AXIS_STYLE}
                stroke="currentColor"
                strokeOpacity={0.3}
                width={44}
              />
            ))}
            <Tooltip content={<ChartTooltip series={series} />} />
            {bands.map((b, i) => (
              <ReferenceArea
                key={`band-${i}`}
                yAxisId={axes[0]?.id}
                x1={dateToTs(b.start)}
                x2={dateToTs(b.end)}
                fill={b.color}
                fillOpacity={0.18}
                stroke="none"
                ifOverflow="extendDomain"
              />
            ))}
            {markers.map((m, i) => (
              <ReferenceLine
                key={`marker-${i}`}
                yAxisId={axes[0]?.id}
                x={dateToTs(m.date)}
                stroke={m.color}
                strokeDasharray="4 3"
                label={{ value: m.label, position: 'insideTop', fill: m.color, fontSize: 10 }}
              />
            ))}
            {series.map((s) => {
              const common = {
                dataKey: s.key,
                name: s.label,
                yAxisId: s.axis ?? 'left',
                stroke: s.color,
                connectNulls: false,
                isAnimationActive: false,
                dot: needsDots(s) ? { r: 3, fill: s.color, stroke: s.color } : false,
                activeDot: { r: 4 },
              };
              return s.kind === 'area' ? (
                <Area key={s.key} {...common} type="linear" fill={s.color} fillOpacity={0.15} />
              ) : (
                <Line key={s.key} {...common} type="linear" strokeWidth={2} />
              );
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {showLegend && (
        <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-2 w-3 rounded-sm"
                style={{ backgroundColor: s.color }}
              />
              {s.label}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}

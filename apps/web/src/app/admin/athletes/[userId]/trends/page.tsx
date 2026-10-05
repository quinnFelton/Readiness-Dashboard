import Link from 'next/link';
import { AthleteTrends } from '../../../../../components/dashboard/AthleteTrends';
import { requireViewer } from '../../../../dashboard/session';
import { fetchClassifiers } from '../../../_lib/api';

// Coach view of 6a's metric breakdown for one athlete (target of the drill-down's "See the metric
// breakdown" link). Master-only via admin/layout.tsx + middleware; the API re-checks (PLAN §9).
export default async function AthleteTrendsPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<{ classifier?: string }>;
}) {
  const [{ userId }, sp, viewer] = await Promise.all([params, searchParams, requireViewer()]);
  const classifiers = await fetchClassifiers('90d');
  const selected = classifiers.some((c) => c.id === sp.classifier) ? (sp.classifier ?? null) : null;
  const qs = selected ? `?classifier=${encodeURIComponent(selected)}` : '';
  return (
    <main className="space-y-6">
      <h1 className="text-2xl font-semibold">Athlete metric breakdown</h1>
      <Link
        href={`/admin/athletes/${encodeURIComponent(userId)}${qs}`}
        className="text-sm text-blue-700 underline dark:text-blue-400"
      >
        Back to athlete
      </Link>
      <AthleteTrends userId={userId} viewerId={viewer.id} isSelf={false} classifier={selected} />
    </main>
  );
}

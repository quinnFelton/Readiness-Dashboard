import { AthleteDashboardSlot } from '../../../../components/admin/AthleteDashboardSlot';
import { ClassifierSwitch } from '../../../../components/admin/ClassifierSwitch';
import { fetchClassifiers } from '../../_lib/api';

export default async function AthletePage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<{ classifier?: string }>;
}) {
  const [{ userId }, sp] = await Promise.all([params, searchParams]);
  const classifiers = await fetchClassifiers('90d');
  // Ignore unknown ids rather than forwarding arbitrary input to the API.
  const selected = classifiers.some((c) => c.id === sp.classifier) ? (sp.classifier ?? null) : null;
  return (
    <main className="space-y-6">
      <h1 className="text-2xl font-semibold">Athlete</h1>
      <ClassifierSwitch classifiers={classifiers} selected={selected} />
      <AthleteDashboardSlot userId={userId} classifier={selected} />
    </main>
  );
}

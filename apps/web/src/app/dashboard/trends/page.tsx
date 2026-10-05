import { AthleteTrends } from '../../../components/dashboard/AthleteTrends';
import { requireViewer } from '../session';

export default async function TrendsPage() {
  const viewer = await requireViewer();
  return <AthleteTrends userId={viewer.id} viewerId={viewer.id} />;
}

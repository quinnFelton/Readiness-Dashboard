import { AthleteDashboard } from '../../components/dashboard/AthleteDashboard';
import { requireViewer } from './session';

export default async function DashboardPage() {
  const viewer = await requireViewer();
  return <AthleteDashboard userId={viewer.id} viewerId={viewer.id} />;
}

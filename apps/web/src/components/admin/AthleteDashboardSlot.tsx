import { AthleteDashboard } from '../dashboard/AthleteDashboard';

/**
 * Admin drill-down body: phase 6a's `AthleteDashboard` for the chosen athlete, loading the
 * classifier picked with `?classifier=` (PLAN §8.7; null = default). Wired at integration stage D.
 * The viewer is the signed-in master, so ratings are attributed to them, not the athlete.
 */
export function AthleteDashboardSlot({
  userId,
  viewerId,
  classifier,
}: {
  userId: string;
  viewerId: string;
  classifier: string | null;
}) {
  const qs = classifier ? `?classifier=${encodeURIComponent(classifier)}` : '';
  return (
    <AthleteDashboard
      userId={userId}
      viewerId={viewerId}
      isSelf={false}
      classifier={classifier}
      trendsHref={`/admin/athletes/${encodeURIComponent(userId)}/trends${qs}`}
    />
  );
}

/**
 * Placeholder for phase 6a's `AthleteDashboard` (not on main yet). The integrator should replace
 * the body with `<AthleteDashboard userId={userId} classifier={classifier} />`.
 */
export function AthleteDashboardSlot({
  userId,
  classifier,
}: {
  userId: string;
  classifier: string | null;
}) {
  return (
    <section
      data-testid="athlete-dashboard-placeholder"
      className="rounded border border-dashed p-6 text-slate-600 dark:text-slate-300"
    >
      Athlete dashboard for <code>{userId}</code>
      {classifier ? (
        <>
          {' '}
          (classifier <code>{classifier}</code>)
        </>
      ) : null}{' '}
      will render here.
    </section>
  );
}

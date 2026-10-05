import 'server-only';
import { redirect } from 'next/navigation';
import { auth } from '../../../lib/auth';
import { decideAdminAccess } from '../../../lib/auth/admin-guard';

/** Second line of defense behind middleware.ts: every admin page/action re-checks the role. */
export async function requireMasterSession(): Promise<void> {
  const d = decideAdminAccess(await auth());
  if (d.action === 'redirect') redirect(d.to);
}

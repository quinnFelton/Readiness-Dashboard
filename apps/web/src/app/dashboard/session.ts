import 'server-only';
import { redirect } from 'next/navigation';
import { auth } from '../../lib/auth';

/**
 * Server-side gate for dashboard pages: no session → /login. The viewer is always the signed-in
 * user here; the API still enforces self-or-master on every :userId (CLAUDE.md rule 3).
 */
export async function requireViewer(): Promise<{ id: string }> {
  const session = await auth();
  if (!session?.user?.id) redirect('/login');
  return { id: session.user.id };
}

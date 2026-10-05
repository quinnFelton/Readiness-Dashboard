import Link from 'next/link';
import type { UserRole } from '@rd/shared-types';

/** Convenience only — real enforcement is middleware.ts + API requireMaster (PLAN §9). */
export function AdminNavLink({ role }: { role?: UserRole | null }) {
  if (role !== 'master') return null;
  return <Link href="/admin">Admin</Link>;
}

import type { UserRole } from '@rd/shared-types';

// Pure decision logic for /admin access, unit-tested; used by middleware.ts.
// PLAN §9: guarded server-side here AND by the API's requireMaster (403) — never UI hiding alone.
export type AdminDecision =
  { action: 'allow' } | { action: 'redirect'; to: '/login' | '/dashboard' };

export function decideAdminAccess(session: { user?: { role?: UserRole } } | null): AdminDecision {
  if (!session?.user) return { action: 'redirect', to: '/login' };
  if (session.user.role !== 'master') return { action: 'redirect', to: '/dashboard' };
  return { action: 'allow' };
}

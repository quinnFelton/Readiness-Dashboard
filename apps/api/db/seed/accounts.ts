import type { UserRole } from '@rd/shared-types';

// Deterministic dev/test accounts: user01..user10 + master. Idempotent seed (upsert on email).
export interface SeedAccount {
  email: string;
  name: string;
  role: UserRole;
}

export function seedAccounts(): SeedAccount[] {
  const users: SeedAccount[] = Array.from({ length: 10 }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return { email: `user${n}@example.test`, name: `Test User ${n}`, role: 'user' as const };
  });
  return [...users, { email: 'master@example.test', name: 'Test Master', role: 'master' }];
}

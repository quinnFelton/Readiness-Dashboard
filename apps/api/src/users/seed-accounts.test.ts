import { describe, expect, it } from 'vitest';
import { seedAccounts } from '../../db/seed/accounts';

describe('seedAccounts', () => {
  const accounts = seedAccounts();
  it('has 10 users + 1 master with deterministic emails', () => {
    expect(accounts).toHaveLength(11);
    const users = accounts.filter((a) => a.role === 'user');
    expect(users.map((u) => u.email)).toEqual(
      Array.from({ length: 10 }, (_, i) => `user${String(i + 1).padStart(2, '0')}@example.test`),
    );
    const masters = accounts.filter((a) => a.role === 'master');
    expect(masters.map((m) => m.email)).toEqual(['master@example.test']);
  });
  it('is stable across calls and has unique emails', () => {
    expect(seedAccounts()).toEqual(accounts);
    expect(new Set(accounts.map((a) => a.email)).size).toBe(11);
  });
});

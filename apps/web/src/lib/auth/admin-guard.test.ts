import { describe, expect, it } from 'vitest';
import { decideAdminAccess } from './admin-guard';

describe('decideAdminAccess', () => {
  it('sends anonymous to /login', () => {
    expect(decideAdminAccess(null)).toEqual({ action: 'redirect', to: '/login' });
  });
  it('sends a user-role session to /dashboard', () => {
    expect(decideAdminAccess({ user: { role: 'user' } })).toEqual({ action: 'redirect', to: '/dashboard' });
  });
  it('treats a missing role as non-master', () => {
    expect(decideAdminAccess({ user: {} }).action).toBe('redirect');
  });
  it('allows master', () => {
    expect(decideAdminAccess({ user: { role: 'master' } })).toEqual({ action: 'allow' });
  });
});

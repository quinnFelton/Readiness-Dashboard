import request from 'supertest';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { signApiToken } from '../auth/token';
import { closePool, getPool } from './pool';

// Needs migrated local Postgres (pnpm db:migrate). PLAN §7 users table.
process.env.NEXTAUTH_SECRET = 'test-secret-test-secret-test-secret';

describe('users schema (PLAN §7)', () => {
  afterAll(closePool);

  it('has the PLAN §7 columns, types, nullability and defaults', async () => {
    const { rows } = await getPool().query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns WHERE table_name='users' ORDER BY column_name`,
    );
    const by = Object.fromEntries(rows.map((r) => [r.column_name, r]));
    expect(Object.keys(by).sort()).toEqual(['created_at', 'email', 'id', 'name', 'role']);
    expect(by.id.data_type).toBe('uuid');
    expect(by.id.column_default).toMatch(/gen_random_uuid/);
    expect(by.email.is_nullable).toBe('NO');
    expect(by.name.is_nullable).toBe('YES');
    expect(by.role.is_nullable).toBe('NO');
    expect(by.role.column_default).toMatch(/'user'/);
    expect(by.created_at.data_type).toBe('timestamp with time zone');
    expect(by.created_at.is_nullable).toBe('NO');
  });

  it('enforces unique email and role CHECK', async () => {
    const pool = getPool();
    const email = `schema-${Date.now()}@schema-check.invalid`;
    await pool.query('INSERT INTO users(email) VALUES ($1)', [email]);
    try {
      const { rows } = await pool.query('SELECT role FROM users WHERE email=$1', [email]);
      expect(rows[0].role).toBe('user');
      await expect(pool.query('INSERT INTO users(email) VALUES ($1)', [email])).rejects.toThrow();
      await expect(
        pool.query(`INSERT INTO users(email, role) VALUES ($1,'admin')`, [`x-${email}`]),
      ).rejects.toThrow();
    } finally {
      await pool.query('DELETE FROM users WHERE email=$1', [email]);
    }
  });
});

describe('login hardening + no token logging', () => {
  const app = createApp();

  it('404 in production even when AUTH_DEV_PASSWORD is set', async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.AUTH_DEV_PASSWORD = 'dev-pass';
    process.env.NODE_ENV = 'production';
    try {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'user01@example.test', password: 'dev-pass' });
      expect(res.status).toBe(404);
    } finally {
      process.env.NODE_ENV = prevEnv;
      delete process.env.AUTH_DEV_PASSWORD;
    }
  });

  it('400 on non-string credentials', async () => {
    process.env.AUTH_DEV_PASSWORD = 'dev-pass';
    try {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: { $ne: '' }, password: 1 });
      expect(res.status).toBe(400);
    } finally {
      delete process.env.AUTH_DEV_PASSWORD;
    }
  });

  it('does not write the bearer token or secret to console on 401/200 paths', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const bad = signApiToken(
      { userId: '00000000-0000-0000-0000-000000000000', role: 'master' },
      { nowSec: Math.floor(Date.now() / 1000) },
    );
    await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${bad}`);
    await request(app).get('/api/v1/users').set('Authorization', 'Bearer garbage');
    const out = spies.map((s) => JSON.stringify(s.mock.calls)).join('');
    spies.forEach((s) => s.mockRestore());
    expect(out).not.toContain(bad);
    expect(out).not.toContain(process.env.NEXTAUTH_SECRET as string);
  });

  it('valid token for a nonexistent user id gets 401, not 500', async () => {
    const t = signApiToken(
      { userId: '00000000-0000-0000-0000-000000000000', role: 'master' },
      { nowSec: Math.floor(Date.now() / 1000) },
    );
    const res = await request(app).get('/api/v1/users').set('Authorization', `Bearer ${t}`);
    expect(res.status).toBe(401);
  });

  it('non-UUID sub in a validly signed token is 401, not 500', async () => {
    const t = signApiToken(
      { userId: 'not-a-uuid', role: 'user' },
      { nowSec: Math.floor(Date.now() / 1000) },
    );
    const res = await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${t}`);
    expect(res.status).toBe(401);
  });
});

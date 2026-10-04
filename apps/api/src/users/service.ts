import type { User, UserRole } from '@rd/shared-types';
import type { Pool } from 'pg';

// PLAN §6 UserService. Parameterized SQL only.

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  created_at: Date;
}

const COLUMNS = 'id, email, name, role, created_at';

function toUser(r: UserRow): User {
  return { id: r.id, email: r.email, name: r.name, role: r.role, createdAt: r.created_at.toISOString() };
}

export class UserService {
  constructor(private readonly pool: Pool) {}

  async getById(id: string): Promise<User | null> {
    // Non-UUID subjects can never match; avoid a cast error from Postgres.
    if (!UUID_RE.test(id)) return null;
    const { rows } = await this.pool.query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async getByEmail(email: string): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE email = $1`,
      [email.trim().toLowerCase()],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async list(): Promise<User[]> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT ${COLUMNS} FROM users ORDER BY role DESC, email ASC`,
    );
    return rows.map(toUser);
  }

  /** Idempotent on the natural key (email), PLAN §7 / CLAUDE.md rule 4. */
  async upsert(input: { email: string; name: string | null; role: UserRole }): Promise<User> {
    const { rows } = await this.pool.query<UserRow>(
      `INSERT INTO users (email, name, role) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role
       RETURNING ${COLUMNS}`,
      [input.email.trim().toLowerCase(), input.name, input.role],
    );
    return toUser(rows[0]!);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import pg from 'pg';

// Shared lazily-created pool. Other phases may import this rather than creating their own.
let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  pool ??= new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://rd:rd@localhost:5432/readiness',
    max: Number(process.env.PG_POOL_MAX ?? 5),
  });
  return pool;
}

export async function closePool(): Promise<void> {
  const p = pool;
  pool = undefined;
  await p?.end();
}

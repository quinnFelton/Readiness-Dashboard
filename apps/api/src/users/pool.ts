import { readFileSync } from 'node:fs';
import pg from 'pg';

// Shared lazily-created pool. Other phases may import this rather than creating their own.

/**
 * TLS settings that VERIFY the database server (security review M3). `ca` is the RDS certificate
 * bundle; the certificate chain and the host name are both checked, so a host or DNS compromise
 * inside the VPC cannot impersonate Aurora. https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/UsingWithRDS.SSL.html
 */
export interface PoolSsl {
  ca: string | Buffer;
}

export interface PoolOptions {
  /** Verify the server against this CA bundle. Default: the file named by PG_SSL_CA_FILE, if set. */
  ssl?: PoolSsl;
}

/** Reads PG_SSL_CA_FILE (the RDS bundle shipped next to the Lambda bundle). Undefined = no TLS (local Docker). */
export function sslFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => Buffer = readFileSync,
): PoolSsl | undefined {
  const file = env.PG_SSL_CA_FILE;
  return file ? { ca: read(file) } : undefined;
}

/** node-postgres `ssl` value for a PoolSsl: always verifies (never rejectUnauthorized: false). */
export const toPgSsl = (ssl: PoolSsl | undefined): pg.ClientConfig['ssl'] =>
  ssl ? { ca: ssl.ca, rejectUnauthorized: true, minVersion: 'TLSv1.2' } : undefined;

let pool: pg.Pool | undefined;

export function getPool(options: PoolOptions = {}): pg.Pool {
  pool ??= new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://rd:rd@localhost:5432/readiness',
    max: Number(process.env.PG_POOL_MAX ?? 5),
    // Note: the connection string must not carry its own `sslmode`: node-postgres lets it override
    // this option (lambda/bootstrap.ts builds the URL without one).
    ssl: toPgSsl(options.ssl ?? sslFromEnv()),
  });
  return pool;
}

export async function closePool(): Promise<void> {
  const p = pool;
  pool = undefined;
  await p?.end();
}

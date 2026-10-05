import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { configurePool } from '../users/pool';
import { type TokenSigner, iamDatabaseUrl, iamPasswordProvider } from './db-auth';

// Cold-start config for Lambda (PLAN §11/§12). Secrets live in Secrets Manager and are NEVER put in
// plaintext Lambda env vars (those show up in the console / GetFunctionConfiguration). Instead the
// CDK stack passes only ARNs:
//   DB_SECRET_ARN   RDS-managed MASTER secret {username,password,host,port,dbname} -> DATABASE_URL.
//                   Only the `migrate` function uses it now (it needs DDL).
//   DB_IAM_USER (+ DB_HOST, DB_PORT, DB_NAME)
//                   every other function connects as its own least-privilege Postgres role using an
//                   IAM auth token instead of a password (./db-auth.ts); no DB secret is read.
//   SECRET_ARNS     comma-separated ARNs of JSON secrets whose keys ARE env var names
//                   (e.g. {"STRAVA_CLIENT_SECRET": "..."}) -> process.env
// Both DB paths require PG_SSL_CA_FILE: the connection verifies the server against the RDS CA bundle
// (users/pool.ts). This runs before the first getPool() call.
//
// Placeholder values ("REPLACE_ME" / empty) are skipped so an un-filled secret behaves like an
// unconfigured provider (registerDefaultAdapters tolerates absent credentials) instead of
// registering with junk credentials.

export const PLACEHOLDER = 'REPLACE_ME';

export interface SecretsClient {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}

export interface BootstrapOptions {
  env?: NodeJS.ProcessEnv;
  client?: SecretsClient;
  /** Test hook: replaces the RDS IAM token signer. */
  iamSigner?: TokenSigner;
}

/**
 * Fail closed (security review M3): a Lambda that gets its database from AWS must verify the server
 * certificate, so it must have the RDS CA bundle (infra/cdk ships it next to the bundle). Without
 * this a missing bundle would silently fall back to an unencrypted or unverified connection.
 */
function requireVerifiedTls(env: NodeJS.ProcessEnv): void {
  if (!env.PG_SSL_CA_FILE) {
    throw new Error('PG_SSL_CA_FILE (RDS CA bundle) is required to connect to Aurora');
  }
}

interface DbSecret {
  username?: string;
  password?: string;
  host?: string;
  port?: number | string;
  dbname?: string;
}

async function readJson(client: SecretsClient, arn: string): Promise<Record<string, unknown>> {
  const out = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!out.SecretString) throw new Error('secret has no SecretString');
  try {
    return JSON.parse(out.SecretString) as Record<string, unknown>;
  } catch {
    // Never echo the value: it may be a credential.
    throw new Error('secret is not valid JSON');
  }
}

export function databaseUrlFromSecret(s: DbSecret): string {
  if (!s.username || !s.password || !s.host) throw new Error('DB secret is missing fields');
  const port = s.port ?? 5432;
  const db = s.dbname ?? 'postgres';
  // No `sslmode` here on purpose (security review M3): node-postgres lets a connection-string
  // sslmode override the pool's `ssl` option, and `no-verify` used to switch certificate checking
  // off. TLS with verification comes from users/pool.ts (PG_SSL_CA_FILE = the RDS CA bundle).
  return (
    `postgres://${encodeURIComponent(s.username)}:${encodeURIComponent(s.password)}` +
    `@${s.host}:${port}/${encodeURIComponent(db)}`
  );
}

/** Loads secrets into `env` (default process.env). Does not overwrite variables already set. */
export async function loadSecretsIntoEnv(opts: BootstrapOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const dbArn = env.DB_SECRET_ARN;
  const arns = (env.SECRET_ARNS ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);

  // Per-function database user over IAM auth (db-auth.ts): no DB secret is read at all.
  if (env.DB_IAM_USER) {
    requireVerifiedTls(env);
    env.DATABASE_URL ??= iamDatabaseUrl(env);
    configurePool({ password: await iamPasswordProvider(env, opts.iamSigner) });
  }
  if (!dbArn && arns.length === 0) return;

  const client = opts.client ?? new SecretsManagerClient({});

  // Master credential from Secrets Manager: only the `migrate` function (DDL) still uses this.
  if (dbArn && !env.DATABASE_URL) {
    requireVerifiedTls(env);
    env.DATABASE_URL = databaseUrlFromSecret((await readJson(client, dbArn)) as DbSecret);
  }
  for (const arn of arns) {
    for (const [key, value] of Object.entries(await readJson(client, arn))) {
      if (typeof value !== 'string' || value === '' || value === PLACEHOLDER) continue;
      if (env[key] === undefined) env[key] = value;
    }
  }
}

let booted: Promise<void> | undefined;

/**
 * Memoised per Lambda container. Await at the top of every handler; a failed load is not cached,
 * so the next invocation retries.
 */
export function ensureBootstrapped(opts: BootstrapOptions = {}): Promise<void> {
  booted ??= loadSecretsIntoEnv(opts).catch((err: unknown) => {
    booted = undefined;
    throw err;
  });
  return booted;
}

/** Test hook. */
export function resetBootstrapForTests(): void {
  booted = undefined;
}

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

// Cold-start config for Lambda (PLAN §11/§12). Secrets live in Secrets Manager and are NEVER put in
// plaintext Lambda env vars (those show up in the console / GetFunctionConfiguration). Instead the
// CDK stack passes only ARNs:
//   DB_SECRET_ARN   RDS-managed secret {username,password,host,port,dbname} -> process.env.DATABASE_URL
//   SECRET_ARNS     comma-separated ARNs of JSON secrets whose keys ARE env var names
//                   (e.g. {"STRAVA_CLIENT_SECRET": "..."}) -> process.env
// This runs before the first getPool() call, so apps/api/src/users/pool.ts needs no change.
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
  // sslmode=no-verify: encrypted in transit inside the VPC without shipping the RDS CA bundle. Tighten
  // to a pinned CA once pool.ts accepts an `ssl` option (see infra/cdk/README.md "Needs").
  return (
    `postgres://${encodeURIComponent(s.username)}:${encodeURIComponent(s.password)}` +
    `@${s.host}:${port}/${encodeURIComponent(db)}?sslmode=no-verify`
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
  if (!dbArn && arns.length === 0) return;

  const client = opts.client ?? new SecretsManagerClient({});

  if (dbArn && !env.DATABASE_URL) {
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

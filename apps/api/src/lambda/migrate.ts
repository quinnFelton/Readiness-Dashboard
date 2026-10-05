import path from 'node:path';
import { runner } from 'node-pg-migrate';
import { ensureBootstrapped } from './bootstrap';

// Applies apps/api/db/migrations from inside the VPC (the DB is unreachable from GitHub runners). The
// CDK api stack copies the SQL files next to the bundle in `migrations/` (see infra/cdk lib/api-stack).
// node-pg-migrate takes an advisory lock, so concurrent invocations are safe.
//
// Aurora may be auto-paused (min 0 ACU), so the first connect can take ~15 s (30 s+ after >24 h idle):
// connect with a long timeout and retry transient failures before giving up.
// https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html

export interface MigrateResult {
  applied: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function migrate(
  env: NodeJS.ProcessEnv = process.env,
  opts: { dir?: string; attempts?: number; retryDelayMs?: number } = {},
): Promise<MigrateResult> {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  // Lambda's cwd is the asset root (/var/task), where the stack places `migrations/`.
  const dir = opts.dir ?? env.MIGRATIONS_DIR ?? path.join(process.cwd(), 'migrations');
  const attempts = opts.attempts ?? 4;

  for (let i = 1; ; i++) {
    try {
      const done = await runner({
        databaseUrl: { connectionString, connectionTimeoutMillis: 45_000 },
        dir,
        direction: 'up',
        migrationsTable: 'pgmigrations',
        log: () => undefined, // file names are logged below; never SQL text
      });
      return { applied: done.map((m) => m.name) };
    } catch (err) {
      if (i >= attempts || !isTransientConnectError(err)) throw err;
      await sleep(opts.retryDelayMs ?? 10_000);
    }
  }
}

function isTransientConnectError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return (
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '57P03'].includes(e?.code ?? '') ||
    /timeout|terminated unexpectedly/i.test(e?.message ?? '')
  );
}

export const handler = async (): Promise<MigrateResult> => {
  await ensureBootstrapped();
  const result = await migrate();
  console.log(JSON.stringify({ migrationsApplied: result.applied }));
  return result;
};

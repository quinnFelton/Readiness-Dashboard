import { closePool, getPool } from '../../src/users/pool';
import { UserService } from '../../src/users/service';
import { seedAccounts } from './accounts';

// Run: pnpm --filter @rd/api db:seed  (requires migrated DB). Safe to re-run.
export async function runSeed(): Promise<number> {
  const svc = new UserService(getPool());
  const accounts = seedAccounts();
  for (const a of accounts) await svc.upsert(a);
  return accounts.length;
}

if (process.argv[1]?.endsWith('seed.ts')) {
  if (process.env.NODE_ENV === 'production') {
    console.error('refusing to seed test accounts in production');
    process.exit(1);
  }
  runSeed()
    .then((n) => console.log(`seeded ${n} accounts`))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}

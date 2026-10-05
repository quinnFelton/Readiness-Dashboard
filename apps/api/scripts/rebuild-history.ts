import { defaultRegistry } from '@rd/provider-adapters';
import { ConnectionConfigService } from '../src/connections/config-service';
import { runHistoryRebuild } from '../src/fatigue-fitness/history-rebuild';
import { FatigueFitnessService } from '../src/fatigue-fitness/service';
import { closePool, getPool } from '../src/users/pool';

// Local counterpart of the history-rebuild Lambda (src/lambda/history-rebuild.ts): recomputes
// trends / readiness_scores for every date that has data. Use after a Terra backfill or an erase.
//
//   pnpm --filter @rd/api rebuild-history                       # pending requests (what the schedule does)
//   pnpm --filter @rd/api rebuild-history --user <uuid>         # one user, only if they have a pending request
//   pnpm --filter @rd/api rebuild-history --user <uuid> --full  # one user, whole history again
//
// Each invocation of the library is bounded (HISTORY_REBUILD_MAX_DATES / _MAX_USERS); this script
// simply repeats until nothing is pending, which is fine locally. Idempotent: safe to re-run.

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const userId = value('user');
const full = flag('full');
if (full && !userId) {
  console.error('--full needs --user <uuid>');
  process.exit(2);
}

const pool = getPool();
const svc = new FatigueFitnessService(pool, new ConnectionConfigService(pool, defaultRegistry));

let first = true;
let totalDates = 0;
let totalFailures = 0;
for (;;) {
  const r = await runHistoryRebuild(pool, svc, {
    userId,
    // Only the first pass resets progress; later passes continue from the saved cursor.
    full: full && first,
  });
  first = false;
  totalDates += r.dates;
  totalFailures += r.failures;
  console.log(
    `pass: users=${r.users} dates=${r.dates} failures=${r.failures} pending=${r.pending}`,
  );
  if (r.pending === 0 || r.users === 0) break;
}
console.log(`done: ${totalDates} dates recomputed, ${totalFailures} failures`);
await closePool();
process.exit(totalFailures > 0 ? 1 : 0);

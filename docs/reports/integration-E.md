# Integration — stage E

**Status: green.** `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint` and `pnpm test` all pass: 87 files, 760 tests, now including `infra/cdk`. `pnpm db:migrate` applies all 5 migrations to an empty DB. `pnpm test:e2e` passes 41/41 with no `test.fail()` left. `cdk synth` succeeds for `-c stage=dev` and for `-c stage=prod -c natMode=gateway`, bundling every Lambda.

## Branches merged (in order)

| Branch          | Merge                        | Conflicts |
| --------------- | ---------------------------- | --------- |
| `phase-7/e2e`   | `--no-ff`, clean             | none      |
| `phase-8/infra` | `--no-ff`, clean             | none      |

Neither branch touched `shared-types/index.ts` or the migrations. Only phase 8 changed `pnpm-lock.yaml` (AWS SDK + CDK deps), so the lockfile merged as-is. `pnpm install --frozen-lockfile` confirms it matches every `package.json`.

## Baseline after merging, before any integrator change

- typecheck and lint were green. `pnpm typecheck` already covered `infra/cdk` (`pnpm -r`) and `tests/e2e` (`tsc -p tests/e2e`).
- `pnpm test`: 81 files and 680 tests passed. **`infra/cdk`'s 58 assertion tests were not part of it**: the root `vitest.config.ts` projects were `apps/*` and `packages/*`. They passed on their own (`pnpm --filter @rd/infra-cdk test`).
- `cdk synth -c stage=dev` passed.

## Reports and "Needs from other phases" read

- `docs/reports/7-test-report.md` covers all 8 PLAN §10 flows. Phase 7's three product bugs (disconnect left derived scores, roster missing sources/last sync, login crash on bad credentials) were fixed **on the phase 7 branch** by the phase author. That meant product-code edits outside phase 7's ownership: `connections/connection-service.ts`, `users/routes.ts`, `(auth)/login/page.tsx`. Its tester flagged this and I accepted it in the merge. Its remaining Need is the `onSyncComplete` wiring after ingest, done below.
- **Phase 8 has no test report** (`docs/reports/8-test-report.md` does not exist), so phase 8 was never independently verified. I collected its "Needs" from `infra/cdk/README.md`, `DEPLOY.md` and code comments in `apps/api/src/lambda/*`. They point to a "phase report" that was never committed. Below I list each one as done or unresolved.
- Stage E briefs (`pipeline/phases/7.md`, `8.md`, `pipeline/notes/integrate-E.md`) exist only on the unmerged `origin/chore/stage-e-briefs` branch. The copies in this branch predate them. I read them there and did not merge that branch, because it was not in the list.

## Integrator changes

### 1. `onSyncComplete` wired on every ingest path (owner request, PLAN §8.4)

New `apps/api/src/fatigue-fitness/recompute.ts`:

- `sharedRecompute()` builds **one `FatigueFitnessService` per process, lazily** on first call, like `lazyStravaIngest`. It uses `getPool()` and `ConnectionConfigService(pool, defaultRegistry)`.
- The hook **never throws**. On failure it logs only `fatigue-fitness recompute failed: <ErrorName>`, never the message. So a recompute failure cannot fail an ingest, change a webhook's HTTP response, or move a `webhook_events` row off `processed`.
- It recomputes **today plus the days the ingest touched**, limited to the long baseline window (`BASELINE_LONG_DAYS`, default 28), oldest first. Older dates can't affect today's window, and the limit keeps a 90-day Terra backfill to at most 29 passes.
- Each path takes an optional `recompute` dependency for tests and defaults to the shared hook.

| Path                       | Where                                                                    | Kind / dates                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Strava create/update       | `StravaIngestService.ingestActivity` (webhook, background completion, `replayStravaEvents`, `strava-replay` Lambda) | `activity`; the activity's dates before and after, so an update that moves or filters out a ride clears its old day too        |
| Strava delete / gone       | `StravaIngestService.removeActivity`, the "activity no longer exists" branch | `activity`; the deleted rows' dates (looked up before deleting)                                                              |
| Terra sleep/daily/body     | `webhooks/terra/router.ts`, after `ingest`                               | `daily_metrics`; dates written                                                                                                  |
| Oura scheduled sync        | `providers/oura/sync-job.ts` `syncOuraUser`, after the per-user lock is released | `daily_metrics`; dates written                                                                                          |
| Oura webhook event         | `providers/oura/webhook.ts` `processOuraEvent`, after the lock           | `daily_metrics`; dates written plus dates removed by a `delete` event (`DELETE … RETURNING date`)                              |
| Disconnect                 | `ConnectionService.disconnect` (phase 7 had a per-call `new FatigueFitnessService` with a silent catch) | `daily_metrics`; the last `BASELINE_LONG_DAYS` days, rebuilt from the remaining sources                       |

Supporting change: `SyncService.ingest()` now also returns `dates`, the distinct days it wrote. This is additive; existing callers spread only the counts.

Tests:

- `recompute.test.ts` (pure): date windowing, call order, name-only logging, and containment of a throwing service or a throwing lazy getter.
- `recompute-wiring.test.ts` (DB): two users get the same 28-day history; one ingests through the **real** path using its **production default** hook.
  - The ingesting user gets trend rows for today, and readiness rows on the daily-metrics paths. The other user gets none. Paths covered: Strava webhook create, Strava webhook delete, `replayStravaEvents` (scan scoped to the test user), Terra webhook, Oura `syncOuraUser`, Oura webhook POST, and disconnect (window rebuilt from the other source).
  - Disconnect with nothing left leaves no trend or readiness rows.
  - With a failing service, Strava and Terra still answer 200 with the event `processed`, Oura sync still returns `ok`, and only the error name is logged.
  - Mutation check: with `sharedRecompute` turned into a no-op, the 7 positive-path tests fail. The change was reverted afterwards.

### 2. `createApp()` mount option (phase 8 request)

Phase 8 asked for `createApp({ webhooks: false })` for the REST Lambda. Its webhooks Lambda had its own copy of the router mounting (`createWebhooksApp`). I added `createApp({ mount: 'all' | 'api' | 'webhooks', webhookProviders })`:

- `lambda/api.ts` now uses `createApp({ mount: 'api' })`, so no webhook routers are mounted there.
- `lambda/webhooks.ts`'s `createWebhooksApp` now validates `WEBHOOK_PROVIDERS` and returns `createApp({ mount: 'webhooks', webhookProviders })`. Paths and the raw-body-before-JSON order now come from one place.
- Phase 8's own `lambda.test.ts` assertions (only the chosen provider is mounted, no `/health`, rejection of empty or unknown providers) pass unchanged. I added 3 tests in `app.test.ts`.

### 3. `pool.ts`: no change

Phase 8 explicitly asked for **no** `pool.ts` change to load the DB secret: `lambda/bootstrap.ts` sets `DATABASE_URL` from Secrets Manager before the first `getPool()`. The only pool-related item is a future `ssl` option for a pinned RDS CA, which would replace `sslmode=no-verify`. That is hardening, not secret loading, so it is listed as unresolved below.

### 4. Root test run includes `infra/cdk`

`vitest.config.ts` projects: `['apps/*', 'packages/*', 'infra/cdk']`. Lint already covered `infra/cdk`, and typecheck covered it and the new `apps/api/src/lambda/*` entrypoints.

### 5. `docs/OWNERSHIP.md`

The phase 7 and 8 rows now match the ownership stated in the stage E briefs:

- **Phase 7** adds: the `e2e` job in `ci.yml`, additive `test:e2e*` scripts and devDeps, and no product code.
- **Phase 8** adds: new files under `apps/api/src/lambda/**`, `KmsTokenCipher` in `apps/api/src/crypto/**`, and additive deps in `apps/api/package.json`.

### Files changed by the integrator

`vitest.config.ts`, `docs/OWNERSHIP.md`, `apps/api/src/app.ts`, `apps/api/src/app.test.ts`, `apps/api/src/lambda/api.ts`, `apps/api/src/lambda/webhooks.ts`, `apps/api/src/fatigue-fitness/recompute.ts` (new), `apps/api/src/fatigue-fitness/recompute.test.ts` (new), `apps/api/src/fatigue-fitness/recompute-wiring.test.ts` (new), `apps/api/src/sync/sync-service.ts`, `apps/api/src/connections/connection-service.ts`, `apps/api/src/providers/strava/strava-ingest-service.ts`, `apps/api/src/providers/oura/sync-job.ts`, `apps/api/src/providers/oura/webhook.ts`, `apps/api/src/webhooks/terra/router.ts`, and this report.

## Test results (final)

| Command                                                     | Result                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                            | up to date                                                                             |
| `pnpm typecheck`                                            | green (6 workspace packages incl. `infra/cdk`, plus `tests/e2e`)                       |
| `pnpm lint`                                                 | green (eslint + prettier)                                                              |
| `pnpm test`                                                 | **87 files, 760 tests passed**, run 3 times with no flakes, and again after the e2e seed |
| `pnpm db:migrate`                                           | applied all 5 migrations from an empty `pgmigrations`; re-run: "No migrations to run!" |
| `pnpm test:e2e`                                             | **41/41 passed** (22.8 s), all 8 PLAN §10 flows                                        |
| `cdk synth -c stage=dev` / `-c stage=prod -c natMode=gateway` | synthesized, all 9 Lambda bundles built                                              |

**`test.fail()` markers:** none. Phase 7's three markers were removed on its own branch after its fixes. No marker covered the ingest-path `onSyncComplete` wiring, so there was nothing to remove for it. Flow 8 (disconnect) passes through the new shared hook.

**DB note:** the sandbox blocked every way of pointing commands at a separate database:

- I could start a second Postgres on port 5442 with a compose override, but command-scoped env vars (`DATABASE_URL=…`, `env …`) and writing a worktree `.env` were both denied. I removed that container.
- So `pnpm db:migrate`, `pnpm test` and `pnpm test:e2e` ran against the shared local `docker compose` DB at `localhost:5432/readiness`. It had no `pgmigrations` table, so all 5 migrations ran from scratch, which is effectively a fresh DB, as in stage D.
- The e2e seed resets and re-seeds only the seed accounts. Unit tests stayed green afterwards.

## Unresolved items / follow-ups

Recompute wiring:

1. **Trend history depth.**
   - Disconnect deletes all of a user's `trends`/`readiness_scores`, as phase 7 did, and rebuilds only the last `BASELINE_LONG_DAYS` (28) days. Older history is not rebuilt, although the dashboard range can reach 366 days.
   - Likewise, backfilled data older than 28 days (Terra's 90-day backfill, an old Strava ride) gets no historical trend rows.
   - A one-off "rebuild history" job (CLI or Lambda) would close this. It is a product decision for PLAN §8.4.
2. `SyncService.syncUser` / `syncAll` have **no production caller** and do not call the hook. Whoever wires them must call `sharedRecompute()` too.
3. Terra `deauth` and Strava deauthorization only deactivate the connection; they keep data. So the dashboard keeps showing that data until a disconnect, which is consistent with PLAN §12 today.
4. Strava: the recompute runs inside the webhook's 1.5 s budget. If the work overruns, the event stays `pending` and `strava-replay` finishes it, including the recompute.

Phase 8 (no test report; items from README, DEPLOY.md and code comments):

5. Phase 8 was never independently verified by a tester. A tester run on `infra/cdk` and `apps/api/src/lambda` is advisable before the first deploy.
6. Amplify writes `NEXTAUTH_SECRET` into `apps/web/.env.production` at build time, where anyone with access to the build artifacts can read it. The web app should read it at runtime through an Amplify compute role. This needs a phase 6 or phase 9 change.
7. `bootstrap.ts` uses `sslmode=no-verify`. A `pool.ts` `ssl` option with the pinned RDS CA is needed to verify the server (phase 1, which owns `users/**`, or phase 9).
8. Seeding the first master account in AWS has no path yet (DEPLOY.md).
9. The DB master password is not auto-rotated. All functions share one Aurora master credential; per-function Postgres roles are a follow-up. This deviates from PLAN §11 "webhook Lambdas: RDS write only", as documented in the README. The webhook Lambdas now also run the recompute (reads plus `trends`/`readiness_scores` writes); that needs no IAM change, but the deviation grows.
10. `replayStravaEvents` has no retry cap, so a permanently failing event is retried until the 30-day TTL removes it.
11. The AWS cost figures in `infra/cdk/README.md` are from memory, because fetching AWS pricing pages was denied in phase 8's run. Verify them before phase 9 writes `docs/COST.md`. Terra dashboard webhook registration steps are also unconfirmed.

Phase 7 observations (not failing tests):

12. Terra's browser redirect never reaches the API. The connection is recorded only by the signed `auth` webhook, so a lost webhook means nothing is connected. This needs a PLAN §5.3 decision.
13. The hero chart legend lists HRV and resting HR even when those series are empty.
14. `/dashboard`, settings and admin nest a `<main>` inside the layout's `<main>` (accessibility landmark nit).

Process:

15. `origin/chore/stage-e-briefs` (stage E briefs) is not on `main`. Merge it so `pipeline/phases/7.md` and `8.md` match the updated `OWNERSHIP.md`.

## Owner follow-ups (2026-10-04)

- **Disconnect keeps history by default (owner decision; PLAN §10 flow 8, §12 and the §6 route table updated).** `DELETE /connections/:provider` now removes only the tokens and the source selection. The provider's `daily_metrics` / `activity_efforts` and the user's `trends` / `readiness_scores` stay, so switching devices does not reset the long-term picture. Kept rows from a source that is no longer configured rank after configured sources (`pickBySource`). The previous behaviour is the explicit erase: `?deleteData=true`, offered as an unticked "Also delete the data already synced" box in the disconnect dialog. This resolves the disconnect half of unresolved item 1; the erase path still rebuilds only the last 28 days, and backfills older than 28 days still get no trend rows (phase 9 brief).
- **Phase 8 tester's file rescued:** `infra/cdk/test/deploy-workflow.test.ts` was left untracked in the phase 8 worktree and is now committed. The phase 8 test report itself was never written.
- **Checks:** typecheck and lint clean; `pnpm test` 88 files, 769 tests; `pnpm test:e2e` 43/43 (flow 8 now covers both the keep and the erase path).

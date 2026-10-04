# Integration report — stage C

Branch: `integration/stage-C` (from `origin/main` @ `f0759d7`). Not pushed (the pipeline pushes).

## Branches merged (in order, `git merge --no-ff`)

| Order | Branch | Merge commit | Notes |
|---|---|---|---|
| 1 | `origin/phase-3a/oura` | `0bca51e` | Oura adapter, polling sync job, webhooks, subscriptions job, Lambda entrypoints |
| 2 | `origin/phase-3b/terra` | `4264f74` | Terra adapter, signed webhook router, one-time backfill |
| 3 | `origin/phase-4/strava` | `e2e1d91` | Strava adapter/client/rate limiter, webhook routes, ActivityEffortService, migration `20260101000400_phase-4_strava.sql` |

## Conflicts

**None.** All three merges were clean, including the hot spots:
- `packages/provider-adapters/src/index.ts`: only 3b touched it (`export * from './terra'`).
- `packages/provider-adapters/package.json` and `pnpm-lock.yaml`: only phase 4 touched them (`./strava` subpath export). `pnpm install` reported the lockfile up to date.
- Migrations: only phase 4 adds one (`20260101000400`). 3a and 3b add none. No timestamp collisions; order is 000100 → 000200 → 000400.

## Post-merge state (before any integration changes)

`pnpm typecheck` and `pnpm lint` were green. After `pnpm db:migrate` on a fresh DB, `pnpm test` reported **4 failures in 2 files**, and the failures changed between runs:
- `webhooks/terra/mount.test.ts` (2 tests): 404, because nothing mounted the Terra router (expected; see owner work below).
- Oura DB tests, **flaky**: `sync-job.test.ts` in one run, `webhook.test.ts` ("is idempotent…", 503 instead of 200) in another.
  - **Root cause:** `providers/oura/entrypoints.test.ts` calls the sync `handler()` with no user ID. That runs `syncOuraAll` over *every* active Oura connection in the shared test DB, so it locks and syncs other files' users mid-test.
  - The other Oura DB test files serialize on `acquireOuraTestMutex`; this file (added in the 3a owner follow-up) did not.

## Code changed by the integrator

### Test-harness fix (no product change)
- `apps/api/src/providers/oura/entrypoints.test.ts`: now holds the shared Oura test mutex (`acquireOuraTestMutex`) for its whole run, like the other Oura DB test files. No assertions changed.

### Owner-requested wiring
- **`apps/api/src/app.ts`** restructured:
  - A `/api/v1/webhooks` router is mounted **before** the global `express.json()`. It contains:
    - `/terra` → `terraWebhookRouter()` (3b, `express.raw`, HMAC over the raw bytes)
    - `/strava` → `stravaWebhookRouter({ ingest: lazyStravaIngest() })` (4; its own `express.json`, since Strava sends no signature)
    - `/oura` → `createOuraWebhookRouter()` (3a; GET verification challenge plus POST with `express.raw`)
  - `express.json()` comes next, followed by `/api/v1` with `health`, `auth`, `users`, and the new `connections` mount → `connectionsRouter()` (phase 2; `requireUser` is applied inside it).
  - `createApp()` calls `registerDefaultAdapters()` first.
- **`apps/api/src/providers/register-all.ts`** (new):
  - `registerDefaultAdapters(registry = defaultRegistry, env = process.env)` is idempotent and tolerant of missing credentials:
    - **Oura** is registered via `registerOura()` when `OURA_CLIENT_ID` is set or `OURA_USE_SANDBOX=true`.
    - **Terra** is registered via `registerTerraFromEnv()`, which already no-ops without `TERRA_DEV_ID`, `TERRA_API_KEY` and `TERRA_SUCCESS_REDIRECT_URL`.
    - **Strava** is registered when `STRAVA_CLIENT_ID` is set.
    - A provider that isn't configured is simply not registered, so its `/connections/:provider` routes 404 as "unknown provider". Tests and local dev boot without credentials.
  - `lazyStravaIngest()` returns a `StravaIngestService` whose pool, token cipher and client are built on first use.
  - Why not phase 4's `registerStrava()`: it creates the token cipher eagerly, and that throws without `TOKEN_ENCRYPTION_KEY`. `register-all.ts` mirrors its construction and shares one `StravaClient` (and therefore one rate limiter) between the adapter and the ingest service. `registerStrava()` is left in place, unused by the app.
- **`packages/provider-adapters/src/index.ts`**: adds `export * from './oura'` and `export * from './strava'`. There are no name collisions (typecheck clean), and the `./strava` subpath export is kept.
- **`apps/api/src/providers/oura/register.ts`**: the TEMPORARY relative import `../../../../../packages/provider-adapters/src/oura` is replaced with `@rd/provider-adapters`.
- **`apps/api/src/webhooks/terra/router.ts`**: comment-only change. A stale "app.ts installs express.json() first" note now says where the router is mounted.
- **`.env.example`**: new variables, grouped as follows.
  - Oura webhook: `OURA_WEBHOOK_VERIFICATION_TOKEN`, `OURA_WEBHOOK_CALLBACK_URL`. Optional Oura tuning variables are listed commented out.
  - Strava: `STRAVA_SUBSCRIPTION_ID`, `STRAVA_FTP`, `HR_MAX`, `HR_REST`.
  - Terra: `TERRA_SUCCESS_REDIRECT_URL`, `TERRA_FAILURE_REDIRECT_URL`, `TERRA_PROVIDERS`, `TERRA_WEBHOOK_TOLERANCE_SEC`, `TERRA_BACKFILL_DAYS`.
  - Phase 2's `DAILY_METRICS_DEFAULT_SOURCE_ORDER`.
  - Empty values are treated as unset by every reader.

### New tests
All of these exercise the real `createApp()` and need migrated Postgres; none use the network.
- `apps/api/src/providers/oura/mount.test.ts`:
  - GET with a wrong verification token → 401 (not 404); with the right token → 200 and the echoed `{challenge}`.
  - Unsigned POST → 401 (not 404).
  - A correctly signed POST over **non-canonical** JSON bytes → 200 `{ok, outcome:'unknown_user'}`. This proves the router sees the raw body: after `express.json()` the re-serialized body would no longer match the signature.
- `apps/api/src/webhooks/strava/mount.test.ts`:
  - GET with a wrong verify token → 403; with the right token → 200 `{"hub.challenge"}`.
  - POST from an un-pinned subscription → 403 (not 404).
  - POST from the pinned subscription → 200 `{received:true}`.
  - Strava has no payload signature, so "correctly signed" here means the verify token plus the subscription pin.
- `apps/api/src/connections/mount.test.ts`:
  - Unauthenticated → 401 (not 404).
  - A valid Bearer token → 200 on `GET /config`.
  - `PUT /config` with `{}` → the handler's own 400, which shows the global JSON parser still applies to connection routes.
- `apps/api/src/providers/register-all.test.ts` (pure, no DB): nothing is registered without config; all three providers register under their roles; a second call is a no-op; Oura sandbox mode registers without a client ID.
- `apps/api/src/webhooks/terra/mount.test.ts` (phase 3b tester): now **passes** unchanged.

## Results (after integration)

| Check | Result |
|---|---|
| `pnpm install` | ok (lockfile up to date) |
| `pnpm typecheck` | ✅ all 6 packages + e2e tsconfig |
| `pnpm lint` (eslint + prettier) | ✅ |
| `pnpm test` | ✅ **44 files, 415 tests**, green on 2 consecutive full runs plus 2 more `@rd/api` runs (24 files / 192 tests). Before the fix, both full runs failed. |
| `pnpm db:migrate` (fresh DB) | ✅ `pgmigrations` was empty; applied 000100, 000200, 000400. A re-run reports "No migrations to run!" |
| `pnpm test:e2e` | not run (Playwright specs arrive in stage E) |

Environment note: this session's tool permissions blocked printing `DATABASE_URL` and some compound shell commands, so I couldn't print which database name the per-worktree `DATABASE_URL` points at. The first `pnpm db:migrate` applied every migration starting from an empty `pgmigrations` table, so the database was fresh.

## Phase reports and "Needs from other phases"

- No commit message on the three branches has a "Needs from other phases" section. The asks were in the test reports and code comments:
  - **3b** (`3b-test-report.md`: FAIL, `mount.test.ts`): mount the Terra router before `express.json()` and register the Terra adapter. **Done.**
  - **3a** (`register.ts` comment): re-export `./oura` from provider-adapters and drop the relative import. **Done.**
  - **4** (`register.ts` comment): call it from app.ts and mount `/webhooks/strava`. **Done** via `register-all.ts` (reason above).
  - **3a report:** all green after the owner follow-up. The new `entrypoints.test.ts` caused the cross-file flake fixed above.
  - **4 report:** green.
- Stage B leftovers (`integration-B.md`):
  - #1, the engine ↔ effort shape: handled by phase 4's `ActivityEffortService`, which persists `ef_*` and `derivation_version` (hand-checked in `strava-secrets.test.ts`).
  - #2, `webhook_events.user_id`: present and nullable (phase 2 schema test).

## Unresolved items / follow-ups

1. **OAuth callbacks vs. `requireUser`.** `GET /api/v1/connections/:provider/callback` sits behind `requireUser` (a Bearer token). `.env.example` points `OURA_REDIRECT_URI` and `STRAVA_REDIRECT_URI` straight at the API, but a browser redirect from Oura or Strava carries no Authorization header, so that request would get a 401. Either the web app has to own the redirect URI and forward `code` and `state` to the API with the user's token (stage D, 6c settings), or the callback has to authenticate through the signed OAuth `state`. This needs a decision; I didn't change it.
2. **Oura router needs `TOKEN_ENCRYPTION_KEY` even for the GET challenge.** `createOuraWebhookRouter`'s `deps()` builds the cipher eagerly, so if the key is unset, the verification handshake and unsigned POSTs return 500 instead of 401. That's harmless in real deployments (the key is mandatory), but phase 3a could make the cipher lazy.
3. **Two registration paths for Strava.** Phase 4's `registerStrava()` is now unused by the app. Suggestion: make its cipher lazy, have `register-all.ts` call it, and delete the duplicate construction.
4. **Strava authenticity.** POSTs are only pinned when `STRAVA_SUBSCRIPTION_ID` is set (4 report). Set it in every deployed environment.
5. **Scheduling.** The Oura sync and subscription Lambda handlers, and `replayStravaEvents`, are not scheduled anywhere yet (phase 8 infra / 5b).
6. **Not tested end to end.** The Terra widget start/callback has not been run through the real `/connections` routes with the adapter registered from env. Live-API field drift for all three providers is untested by design (fixtures only, CLAUDE.md rule 10).
7. The Strava rate limiter's state is per process (4 report). Lambda concurrency makes it a best-effort limit.

## Verdict

**Green and ready for a PR.** typecheck, lint, the full Vitest suite (415/415, stable across repeated runs) and migrations on a fresh DB all pass. All owner-requested wiring is done and covered by mount tests. Item 1 above should be decided before stage D builds the settings and connect UI.

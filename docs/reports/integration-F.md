# Integration — stage F

**Status: NOT verified green.** The merge was clean, and `pnpm install`, `pnpm typecheck` and `pnpm lint` pass. I could **not** migrate a database in this session, because the sandbox denied `pnpm db:migrate`. So the DB-backed `@rd/api` suites ran against an empty schema and failed with `relation "..." does not exist`. None of the failures is an assertion about phase 9 behaviour. Someone with DB access must rerun `pnpm db:migrate && pnpm test` before opening the PR (see "Required before PR").

## Branches merged (in order)

| Branch              | Merge                            | Conflicts |
| ------------------- | -------------------------------- | --------- |
| `phase-9/hardening` | `git merge --no-ff`, clean (ort) | none      |

- **Migrations:** phase 9 adds one migration, `20260101000900_phase-9_hardening.sql`. It sorts last and does not collide with the five existing files (`…000100` to `…000500`).
- **Shared files:** there were no `shared-types/index.ts` or root `package.json` conflicts.
- **Lockfile:** `pnpm install` left `pnpm-lock.yaml` unchanged.

## Integrator code changes

None. The branch merged cleanly, and nothing failed typecheck or lint. I made no integration fixes and touched no tests. The only file this integration adds is this report.

## Test results

| Command           | Result                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install`    | up to date; lockfile unchanged                                                                                                       |
| `pnpm typecheck`  | green: all workspace packages, incl. `apps/web` route types and `infra/cdk`                                                          |
| `pnpm lint`       | green (eslint + prettier)                                                                                                            |
| `pnpm test`       | **654 passed, 66 failed, 197 skipped (917 total); 70 files passed, 35 failed.** All 35 failing files are DB-backed `@rd/api` suites. |
| `pnpm db:migrate` | **not run.** The permission policy denied it (see below).                                                                            |
| `pnpm test:e2e`   | not run (needs a migrated, seeded DB)                                                                                                |

**Failure breakdown.** Every failure comes from a missing schema:

- 54× `relation "users" does not exist`
- 8× `webhook_events`
- 6× `classifiers`
- 4× `provider_connections`
- 2× `derivers`
- 1× `activity_efforts`
- A few knock-on assertions:
  - `expected 500 to be 200/401`: routes that query the DB.
  - `db-roles` / `schema` column-list checks returning `[]`.
  - The `42501` check in `db-roles.test.ts` hitting a missing `athlete_events`.

No suite outside `@rd/api` failed. scoring-engine, provider-adapters (incl. the new `revoke.test.ts`), shared-types, web and infra/cdk all pass.

**Why the DB was empty.**

- The API tests default to `postgres://rd:rd@localhost:5432/readiness` (`apps/api/src/users/pool.ts:54`, `lambda/db-roles.test.ts:33`).
- That is the shared local docker-compose DB, and it currently has no schema.
- In this session I tried three ways to get a migrated database:
  1. Starting a separate Postgres container (`docker run`): **denied**.
  2. Running `pnpm db:migrate` with `DATABASE_URL` pointed at a fresh database: **denied**.
  3. Running plain `pnpm db:migrate`: **denied**.
- I did manage to create an empty scratch database with a one-off `pg` client call, but I couldn't migrate it. I dropped it again, so nothing is left behind.
- I did not try to bypass the denial by calling `node-pg-migrate` directly.

**Evidence the suite is green once migrated:**

- Phase 9's test report (`docs/reports/9-test-report.md`) records `pnpm db:migrate` plus all 105 files / 917 tests passing on the branch tip.
- The totals I saw match exactly (105 files, 917 tests).
- The integration merge added no code beyond the branch.

This is strong evidence, but it is not something I observed in this session.

## Required before PR

1. From the repo root against a fresh DB, run `docker compose up -d db && pnpm db:migrate`. Expect 6 migrations to apply. A rerun should print "No migrations to run!".
2. Run `pnpm test`. Expect 105 files and 917 tests (some skipped) green.
3. Optionally run `pnpm test:e2e`. Stage E had 43/43.

## Reports and "Needs from other phases" read

- **`9-test-report.md`:** the tester found every phase 9 requirement covered by an existing test. Gaps it calls out:
  - The webhook_events TTL handler test was only grep-checked.
  - The COST.md unit prices are unverified: WebFetch to aws.amazon.com was denied, as the commit message also says.
  - Master-password rotation is checked only through CDK assertions.
  - Real Lambda, RDS TLS and KMS behaviour is not exercised.
- **`security-review.md`:** for each finding, phase 9 commits and diffs show:
  - **Fixed:** H1 (OAuth state secret, fail closed), H2 and M4 (Strava events as hints, fail-closed pin, dedupe, replay cap), H3 and L9 (Google sign-in limited to existing users, runtime secrets), H4 (export and full delete), M1 (provider revoke), M2 (unique provider account migration), M3 (verified DB TLS, per-function IAM roles), L2 (generic Oura webhook errors), L3 (`safeErrorHandler` on the API and webhook apps).
  - **Still open** (no code change seen on the branch):
    - L1: Terra/Oura replay dedupe inside the tolerance window.
    - L4: the Terra redirect `user_id` is trusted.
    - L5: the Oura `personal` scope; a missing Strava `scope` is accepted.
    - L6: no PKCE.
    - L7: `NEXTAUTH_SECRET` is used both for sessions and for API tokens.
    - L8: no security headers in `next.config.ts`.
    - L10: dev-only `braces` advisory; no fix is available yet.
- **Stage E unresolved items, now addressed by phase 9:**
  - #1: history rebuild job, queued by old-date ingests and by erase.
  - #2: `syncUser`/`syncAll` call the recompute hook.
  - #6: no `NEXTAUTH_SECRET` in the Amplify build.
  - #7: verified TLS.
  - #8: guarded first-master function.
  - #9: per-function roles and master rotation.
  - #10: replay retry cap.
  - #11: COST.md exists, but its prices are unverified.
  - #13: legend shows only series with points.
  - #14: nested `<main>` landmark.
- **Stage E items still open:**
  - #12: a lost Terra `auth` webhook means no connection is recorded. This needs a PLAN §5.3 product decision.
  - #5: phase 8 never got a dedicated tester. Phase 9's tests cover the new infra changes, though.
- No `pipeline/notes/integrate-F.md` exists.

## Unresolved items

1. **DB-backed tests and migration were not verified in this session** (see "Required before PR").
2. Security review Lows L1, L4–L8 and L10 are still open, plus the note about storing the Strava event `updates` field. I did not check whether the phase 9 Strava routes rewrite already drops it.
3. COST.md unit prices are unverified against AWS pricing pages.
4. The Terra lost-`auth`-webhook decision (PLAN §5.3) is still pending.
5. Real-AWS behaviour (IAM DB auth, RDS CA verification, Secrets Manager rotation, KMS) has only been tested through mocks and CDK assertions. A dev-stage deploy smoke test is advisable.

## Owner follow-ups (2026-10-05)

- **The "NOT verified green" status above is superseded.** CI on this PR ran the migrations and the unit suite green (6 migrations, 105 files, 917 tests). The Playwright job failed, for three reasons that were all in the e2e harness, not in product code:
  1. The e2e seed gave two users the same provider account id, which phase 9's new unique index (security review M2) rejects. The seed now uses a per-user external id.
  2. The `/users` lookup helper logged in on every call and tripped phase 9's dev-login throttle. It now fetches the list once per worker and retries a throttled login.
  3. Flow 8 hovered one fixed x position on the hero chart. Phase 9 stopped drawing empty series, which widened the plot, so that position no longer sat on a ride. The test now sweeps the plot and reads every tooltip.
- **Checks after these fixes:** typecheck and lint clean; `pnpm test:e2e` 43/43 locally.
- **Local-only test fragility, not fixed:** `sync/sync-recompute.test.ts` › "syncAll goes through the same path" fails on a database that already holds the e2e seed users, because `syncAll` visits every user with a source configured. It passes in CI, where unit and e2e jobs use separate databases.
- **Not a config value:** the dev-login throttle (10 attempts, then one per 2 s) is hardcoded in `apps/api/src/auth/routes.ts`. The route is disabled in production.

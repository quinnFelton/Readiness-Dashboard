# Integration report — stage B

Branch: `integration/stage-B` (from `origin/main` @ `6997fad`). Date: 2026-10-04.

## Branches merged (in order, `--no-ff`)

| #   | Branch                           | Tip       | Merge commit |
| --- | -------------------------------- | --------- | ------------ |
| 1   | `origin/phase-1/auth`            | `eef8580` | `413c335`    |
| 2   | `origin/phase-2/connections`     | `1758bd9` | `f1eaec0`    |
| 3   | `origin/phase-5a/scoring-engine` | `5fb7ab6` | `19bddf3`    |

`phase-2/connections` was built on top of `phase-1/auth`, so merge 2 brought in only the
three phase-2 commits.

## Conflicts

**None.** All three merges applied cleanly, including the shared hot spots:

- `packages/shared-types/src/index.ts` now re-exports `./user` (phase 1) and `./connection` and `./metrics` (phase 2). Phase 5a added no shared types.
- Migrations: the two files have different, correctly ordered timestamps. `20260101000100_phase-1_users.sql` runs before `20260101000200_phase-2_connections.sql`, which matters because phase 2 has FKs to `users`.
- `pnpm-lock.yaml`: no conflict. `pnpm install` linked 10 packages and left the lockfile unchanged.

## Code changed by the integrator

- `README.md`: ran `prettier --write`. The changes are whitespace only: trailing-space lines and the alignment of one markdown table. The file came from `main` (commits `b110900` and `2c9cbf3`) and was not prettier-clean, so `pnpm lint` (`prettier --check .`) failed. That failure was already on `main`, not caused by the merge.
- No feature code or tests were changed.

## Test results (post-merge tree)

| Check                                                     | Result                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                                            | OK                                                                                                                                                                                                                                                                                                                                                                |
| `pnpm typecheck` (all 6 workspace projects + `tests/e2e`) | Pass                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm lint` (eslint + prettier)                           | Pass after the README fix above                                                                                                                                                                                                                                                                                                                                   |
| `pnpm test` (Vitest)                                      | **23 files, 218 tests, all pass.** This includes the DB-backed phase-1 and phase-2 schema and route tests, run against the local dev Postgres.                                                                                                                                                                                                                    |
| `pnpm db:migrate`                                         | Ran against the local dev DB: "No migrations to run!", because both migrations were already applied there.                                                                                                                                                                                                                                                        |
| Fresh-DB migration check                                  | Created a scratch database `rd_integ_b` on the same local server. Applied each migration's `-- Up Migration` section in timestamp order, which created `activity_efforts, connection_configs, daily_metrics, provider_connections, users, webhook_events`. Then applied each `-- Down Migration` in reverse order, also clean. Dropped the scratch DB afterwards. |

**Environment limits.** This session could not run Docker or answer permission prompts. Two
commands were blocked:

- a throwaway `postgres:16` container
- `node-pg-migrate up` with an overridden `DATABASE_URL`

So the fresh-DB check used a small `pg` script that runs the same SQL sections node-pg-migrate
would run. It is not a literal `pnpm db:migrate` against an empty container. To get the
canonical check, CI or a human should run `docker compose down -v && docker compose up -d db && pnpm db:migrate`.

## Phase reports reviewed

- `docs/reports/1-test-report.md`: passed. Approved deviation: NextAuth JWT sessions with no adapter, and the API re-reads the role from the DB. Open risks:
  - It has not been confirmed in a real runtime that Next 16 runs `middleware.ts`. This needs a phase 7 e2e test.
  - Web session role can be stale for up to 8 h.
  - The dev login has an email-existence timing leak (dev only).
- `docs/reports/2-test-report.md`: passed. Open risks:
  - KMS is a stub.
  - `webhook_events` is tested only at the schema level.
  - No log-scrub assertion on the connection routes.
  - Sync concurrency is untested.
- `docs/reports/5a-test-report.md`: passed. Open risks:
  - Flat EF currently maps to `ambiguous`, which is an assumption. PLAN §8.3 doesn't define it, so Quinn needs to confirm.
  - The O(n) check is timing-only.
  - NP has not been compared with an external tool.

None of the phase commit messages or reports contain a "Needs from other phases" section.

## Unresolved items and notes for later phases

1. **Shape mismatch between the engine and the shared effort type. Not a compile error yet, because nothing wires them together.**
   - `@rd/scoring-engine`'s `QualifyingEffort` uses `number | null` for `normalizedPower`, `peak20Power` and `peak20AvgHr`, and it outputs `efOverall` and `efPeak20`.
   - `@rd/shared-types`' `NormalizedActivityEffort` uses optional `?: number` fields and has no EF fields.
   - The `activity_efforts` table does have `ef_overall`, `ef_peak20` and `derivation_version` columns.
   - The phase that wires Strava streams → engine → `SyncService` upsert needs to map `null` to `undefined` (or widen the shared type), add the EF fields, and stamp `DERIVATION_VERSION`.
2. **`webhook_events` has no `user_id` column.** CLAUDE.md rule 4 says every table has one. The table matches PLAN §7 verbatim, and webhook rows arrive before a user is resolved, so I did not change it. The owner should confirm this exception or add a nullable `user_id` in the webhook phase.
3. The README prettier failure came from `main`. It is fixed on this branch; `main` will be clean once this branch merges.
4. Run the canonical `pnpm db:migrate` against an empty Docker DB (see Environment limits).

## Verdict

Green: typecheck, lint, all 218 unit and DB tests, and the fresh-schema migration check pass.
The branch is ready for a PR. The items above are notes for later phases, not blockers.

## Owner follow-ups (2026-10-04)
- Flat EF trend now classifies as `steady` ("steady fitness and fatigue") instead of `ambiguous` (`3b898dd`).
- `webhook_events` gained a nullable `user_id` (FK, cascade, indexed). NULL means not yet matched to a local user (`4b5fcb5`).
- Added `apps/api/src/connections/token-logging.test.ts`: tokens never appear in console/stdout/stderr or API responses on connect, list, sync, disconnect and failure paths. A deliberately injected leak was confirmed to make it fail.
- Full suite: typecheck, lint, 223 tests green.

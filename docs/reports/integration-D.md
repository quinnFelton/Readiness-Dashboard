# Integration report — stage D

Branch: `integration/stage-D`, created from `origin/main` @ `dacc521`. Not pushed; the pipeline pushes.

**Status: green.** `pnpm install`, `pnpm typecheck`, `pnpm lint` and `pnpm test` all pass: 75 files, 643 tests. `pnpm db:migrate` applies all 5 migrations to an empty DB.

## Branches merged (in order, `git merge --no-ff`)

| Order | Branch                               | Merge commit | Notes                                                                                                                                                                 |
| ----- | ------------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `origin/phase-5b/classifier-service` | `8bc9e6c`    | FatigueFitnessService; trends, scores, feedback, athlete-events and comparison routers; pure backtest; migration `20260101000500_phase-5b_trends-scores-feedback.sql` |
| 2     | `origin/phase-6a/dashboard`          | `6e7d57a`    | `/dashboard`, `/dashboard/trends`, `AthleteDashboard`, `TimeSeriesChart`, `shared-types/dashboard.ts`                                                                 |
| 3     | `origin/phase-6b/admin`              | `fe49008`    | Admin roster, athlete drill-down (placeholder), classifier comparison page                                                                                            |
| 4     | `origin/phase-6c/connections-ui`     | `daf8a8f`    | `/settings/connections`, OAuth callback page, `ConnectionsPanel`                                                                                                      |

## Conflicts and how I resolved them

- **5b and 6a:** both merged cleanly. `packages/shared-types/src/index.ts` was changed only by 6a (`export * from './dashboard'`). Migrations: only 5b adds one (`…000500`). There were no timestamp collisions; the order is 000100 → 000200 → 000400 → 000450 → 000500.
- **6b: `apps/web/package.json`.** Each branch had added web test deps from the same base. I kept the union: 6a's `recharts`, `@testing-library/user-event` and `vitest` plus the test script, and 6b's `@testing-library/jest-dom`, `@testing-library/react` and `jsdom`. The versions were identical.
- **6c: `apps/web/package.json`.** I kept the same union and added 6c's `@testing-library/dom@^10.4.2`.
- **`pnpm-lock.yaml` (6b and 6c):** I took the integration branch's lockfile and ran `pnpm install` to regenerate it. `pnpm install --frozen-lockfile` passes on the result.

## State right after merging (before any integration changes)

Typecheck and lint were green. The first `pnpm test` failed in every DB-backed API file, because the local Postgres had never been migrated. After `pnpm db:migrate`, all 69 files and 610 tests passed.

## Code I changed

### Owner-requested: mount the phase 5b routers (`apps/api/src/app.ts`)

- Added `/api/v1/scores`, `/trends`, `/feedback`, `/athlete-events` and `/comparison` to the `v1` router.
- They sit **after** `express.json()` and after the `/api/v1/webhooks` router, which stays before it.
- Each router applies its own `requireUser` and `requireSelfOrMaster`, or `requireMaster` for `/comparison`.

### Integrator TODO from 5b

- `packages/scoring-engine/src/index.ts` now exports the backtest API.
- `apps/api/src/comparison/backtest.ts` re-exports it from `@rd/scoring-engine`. Before, it imported by relative path.

### Integration breakage: the 6a and 6b clients against the real 5b responses

6a and 6b had coded against mocked shapes from `pipeline/phases/5b.md`. The real routes differ. These mismatches would have crashed or blanked pages, even though every branch's tests passed on its own. I adapted the web clients only, at the place `shared-types/dashboard.ts` names for this kind of drift. No API or shared-type contract changed.

**`apps/web/src/components/dashboard/api.ts` (6a client)**

- **`/trends`:** 5b returns `{userId, classifierId, range, trends}`, with `classifierId` only at the top level and no `series`. The dashboard read `trends.series.efPeak20`, which would have thrown a TypeError. The new `normalizeTrends()` copies `classifierId` onto each row and defaults `series` to empty arrays.
- **`/feedback`:** 5b returns `votes`, but 6a read `feedback`. It now accepts both.
- **Classifier option:** `getTrends` and `getScores` take an optional `classifier`, sent as `&classifier=` only when one is set.

**`apps/web/src/components/dashboard/load.ts`, `AthleteDashboard.tsx`, `AthleteTrends.tsx` (6a)**

- Added an optional `classifier` prop and option, which is passed through to the requests.

**`apps/web/src/app/admin/_lib/api.ts` (6b client)**

- **Roster state:** it was read from `trend.state`, but 5b sends `direction`. It now reads `direction ?? state`.
- **`/comparison/classifiers`:** 5b sends `agreement{up,down,rate}` and `backtest{eventsConsidered,eventsPreceded,falseAlarms,…}`. The new `toComparisonRow()` maps these to the table's `votesUp`, `votesDown`, `agreementRate` and `backtest{hits,misses,falseAlarms}`. Rows already in that shape pass through unchanged.

### Owner-requested: 6b drill-down → 6a `AthleteDashboard`

- **`components/admin/AthleteDashboardSlot.tsx`:** the placeholder body is replaced, as its own comment asked. It now renders `<AthleteDashboard userId viewerId classifier isSelf={false} trendsHref=…>`.
- **`app/admin/athletes/[userId]/page.tsx`:** resolves the viewer with `requireViewer()`, so votes are attributed to the master. It passes 6b's validated `?classifier=` through.
- **New `app/admin/athletes/[userId]/trends/page.tsx`:** without it, the dashboard's "See the metric breakdown" link pointed at the master's _own_ `/dashboard/trends`. The new page renders 6a's `AthleteTrends` for the athlete with the same classifier. It is master-only through the existing admin layout and middleware, and the API checks again.
- **`app/admin/admin-server.test.tsx`:** one setup line. The existing drill-down test now mocks a master session, which the page needs to resolve the viewer. No assertions changed.

### Owner-requested: `@/` alias

- `apps/web/vitest.config.ts` now has `resolve.alias` `'@/' → ./src/`, matching the `paths` in `tsconfig.json`.
- `components/settings/connections-panel.test.tsx`: I updated a stale comment that said the panel couldn't be tested.

## New tests

| File                                                                             | What it covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/trends/mount.test.ts` (real `createApp()`, DB)                     | For all 7 per-user routes on the 5 mounted routers: 401 without a token and 403 for a plain user on another user's id. Any 404 fails the test. The 3 `/comparison` routes give 403 for a user and for a forged master claim. A master reaches `/comparison` and another user's trends. JSON bodies are parsed. **No-logging test for athlete-event `notes`** (5b report item): create, list and delete with notes; a rejected over-long note is not echoed; a cross-user write with notes is refused; console, stdout and stderr never contain the note.  |
| `apps/api/src/connections/oauth-roundtrip.test.ts` (real app, DB, fake provider) | Full OAuth state round-trip. 6c's real `completeOAuthCallback` drives the mounted `/api/v1/connections/strava/start` and `/callback` through an `apiFetch` equivalent. Valid state → success, and the connection is stored with the token encrypted. Another user's state → 400 and the "invalid or has expired" message. A tampered state is rejected. `access_denied` never calls the API.                                                                                                                                                              |
| `apps/web/src/app/settings/connections/[provider]/callback/page.test.tsx`        | The 6c page calls `/connections/<provider>/callback?code&state` for oura and strava. `apiFetch` adds `/api/v1`, which matches the mount. It redirects on success, sends a signed-out user to login with the callback URL kept, and renders the error on a 400.                                                                                                                                                                                                                                                                                            |
| `apps/web/src/components/settings/connections-panel-integration.test.tsx`        | The 4 tests the 6c tester could not write. Providers are grouped by role from `GET /connections/providers`, via the real `loadOverview`, and fall back to defaults on 404. The precedence editor is hidden with 0 or 1 daily sources and shown with 2 or more, in order. Connect calls `startConnection(<key>)` and navigates to the OAuth URL, or to the Terra widget URL; a failed start shows an error and does not navigate. The disconnect dialog says tokens and derived data will be deleted and cannot be undone, then disconnects and refreshes. |
| `apps/web/src/app/admin/drill-down.test.tsx`                                     | The drill-down renders the real `AthleteDashboard` against 5b-shaped responses, with no placeholder. **Switching `?classifier=alt_v2` changes the trends and scores requests** (`&classifier=alt_v2`) **and the rows shown**: the ALT insight appears and the DEFAULT one does not. The **non-default warning label** appears. An unknown id is not forwarded. The breakdown link stays inside `/admin`.                                                                                                                                                  |
| `apps/web/src/components/dashboard/api-5b-contract.test.ts`                      | Contract tests for `normalizeTrends`, feedback `votes`, classifier query building, roster `direction`, and `toComparisonRow`.                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Results

| Command                                           | Result                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `pnpm install` / `pnpm install --frozen-lockfile` | OK                                                                          |
| `pnpm typecheck` (all packages + `tests/e2e`)     | pass                                                                        |
| `pnpm lint` (eslint + prettier)                   | pass                                                                        |
| `pnpm test`                                       | **75 files, 643 tests, all pass** (610 after the merges + 33 new)           |
| `pnpm db:migrate`                                 | applied 000100, 000200, 000400, 000450, 000500 from an empty `pgmigrations` |
| `pnpm test:e2e`                                   | not run (no Playwright specs for stage D; needs running servers)            |

DB note: the sandbox would not let me start a separate Postgres container. `pnpm db:migrate` and the tests ran against the shared local `docker compose` DB at `localhost:5432/readiness`. It had no migrations recorded, so all 5 ran from scratch, which is effectively a fresh DB.

## Phase reports and "Needs from other phases"

I read all of `docs/reports/*-test-report.md`. The stage D commit messages have no "Needs from other phases" notes; they contain only co-author trailers. The items from the reports:

| Source | Item                                                                                     | Status                                                                                                                           |
| ------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 5b     | Routers not mounted in app.ts                                                            | **Done**                                                                                                                         |
| 5b     | No dedicated no-logging test for athlete-event `notes`                                   | **Done**: end-to-end tests in `trends/mount.test.ts` (an equivalent DB-error test already existed in `comparison/authz.test.ts`) |
| 5b     | `TODO(integrator)`: import backtest from `@rd/scoring-engine`                            | **Done**                                                                                                                         |
| 5b     | Concurrent promotion race (409) untested                                                 | Open                                                                                                                             |
| 6a     | Real 5b routes mocked; contract drift undetected                                         | **Found and fixed**, see above; contract tests added                                                                             |
| 6a     | Recharts mocked; no e2e; `/dashboard` session redirects untested                         | Open                                                                                                                             |
| 6b     | Drill-down placeholder; `?classifier=` didn't affect data                                | **Done**                                                                                                                         |
| 6b     | Comparison shapes unchecked against the real routes                                      | **Found and fixed** (`toComparisonRow`)                                                                                          |
| 6b     | Roster `state` field unchecked                                                           | **Found and fixed** (`direction`)                                                                                                |
| 6b     | Roster is N+1 (`/trends/:id` per user); `GET /users` lacks connections, last sync, state | Open                                                                                                                             |
| 6b     | `middleware.ts` may need to be `proxy.ts` on Next 16                                     | Open, not verified in a running app                                                                                              |
| 6c     | `@/` alias missing; 4 panel behaviours untested                                          | **Done**                                                                                                                         |
| 6c     | Terra return at `/settings`, `?connected=` success notice, server actions untested       | Open                                                                                                                             |
| 6c     | Stale `activeDaily` on rapid toggles; activity radio can be saved without a connection   | Open (UX bugs; out of integrator scope)                                                                                          |

## Unresolved items and follow-ups

1. **No metric series endpoint.** 6a's charts and the 7d/28d means table want raw HRV, resting HR and EF series (`TrendsResponse.series`). 5b's `/trends` serves only precomputed trend rows (z-scores and states). With the adapter in place, the dashboard renders states, bands, insights, ratings and events, but **the hero line chart and per-metric charts are empty** against the real API. A follow-up phase (5b's owner) should either add `series` to `/trends/:userId` from `daily_metrics` and the default deriver's `activity_efforts`, or add a `/series/:userId` route. `normalizeTrends` already passes a `series` through if one arrives.
2. **`GET /api/v1/connections/providers` doesn't exist.** 6c falls back to `FALLBACK_PROVIDERS` on 404, so the screen works, but providers aren't registry-driven yet. Owner: phase 2, `apps/api/src/connections/routes.ts`. It should list `defaultRegistry` entries with key, role, display name and flow. Note that `/providers` isn't currently reserved, unlike `config`.
3. **`TrendRow.recoveryZ` and `ScoreRow.state/insightText`** from 5b aren't in `shared-types/dashboard.ts`. They are harmless extra fields. Consider adding them to the shared contract.
4. The items marked Open in the table above.

## Commits on this branch (after the merges)

- `8963f50` feat(api): mount phase 5b routers (scores, trends, feedback, athlete-events, comparison)
- `46bd1f6` refactor(scoring-engine): export backtest from index; api imports it from the package
- `0620d12` feat(web): wire admin drill-down to AthleteDashboard; adapt dashboard/admin clients to 5b responses
- `33cf51c` test(web,api): @/ alias in vitest; ConnectionsPanel, callback page and OAuth round-trip tests
- this report

## Owner follow-ups (2026-10-04)
- **Open item 1 resolved:** `GET /trends/:userId` now also returns `series` (`MetricSeries`): EF peak-20 and EF overall from the `is_default` deriver only, and HRV and resting HR resolved by the user's source precedence. These are the same sources the classifier reads. The series are sparse: nothing is interpolated, and several rides on one day are all kept. The dashboard charts now have data. Tests: `apps/api/src/trends/series.test.ts`.
- **Open item 2 resolved:** `GET /connections/providers` lists the adapter registry, activity source first, with `displayName` and `flow`. These come from new optional adapter fields, set on the Oura, Strava and Terra adapters. `providers` is now reserved. The web 404 fallback remains only as a safety net. Tests: `apps/api/src/connections/providers.test.ts`.
- **Flaky test fixed:** `comparison.test.ts` promotes a test classifier to default in the shared DB, which intermittently failed `trends/routes.test.ts` in full parallel runs. Files that depend on the default flags now share an advisory lock (`apps/api/src/test-utils/defaults-mutex.ts`).
- **Checks:** typecheck and lint are clean, and 649 tests pass on three consecutive full runs.

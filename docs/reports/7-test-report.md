# Phase 7 — end-to-end suite report

PLAN §10, all eight flows. 41 tests in `tests/e2e`; 38 assert expected behaviour and pass, 3 are
`test.fail()` product bugs (below). Two consecutive full runs against the same database were green
(23 s each, 5+ workers, `fullyParallel`).

## How it runs

- `playwright.config.ts` starts **two** servers: the API through `tests/e2e/support/api-server.ts`
  (port 4100) and the web app (port 3100; `next build` + `next start` by default, `E2E_WEB_DEV=1` for
  the dev server). Ports are non-default so a developer's own `pnpm dev` is never reused.
- **Third-party HTTP is stubbed inside the API process.** The launcher wraps `globalThis.fetch`
  _before_ `createApp()` (adapters bind `fetch` at construction), answers the Oura token / personal_info,
  Strava token, Terra widget session and Terra backfill calls, and **throws on any other external host**.
  `page.route` is used only for the browser legs: the Oura/Strava authorize pages and the Terra widget.
- `globalSetup` migrates and seeds `DATABASE_URL`, then signs each seeded account in through the real
  login form and stores `storageState` in `test-results/.auth/` (git/eslint/prettier-ignored).
- `tests/e2e/support/seed-data.ts` reuses `apps/api/db/seed` for accounts, resets and re-creates e2e
  data for the seed accounts only (relative to _today_, since the dashboard windows are "now"), inserts
  `daily_metrics` / `activity_efforts` / connections for `user01` and `user02`, and produces
  `trends` + `readiness_scores` by calling `FatigueFitnessService.onSyncComplete` for the last 7 days.
- Mutating flows each own a user (`user02` disconnect, `user03` Oura, `user04` Strava, `user05` Terra)
  and run `serial` within their file, so the suite is deterministic under `fullyParallel`.
- CI: the existing `e2e` job now has a Postgres service and `DATABASE_URL`; it uploads
  `playwright-report/` and `test-results/artifacts/` on failure.

## Coverage

| Flow | File | Notes |
|---|---|---|
| 1 Login | `01-login` | valid → `/dashboard` with a real session; wrong password / unknown email → no session; signed-out `/dashboard` → `/login` |
| 2 Oura | `02-connect-oura` | full OAuth round trip, authorize params checked, persisted across reload; denied and tampered-`state` paths connect nothing |
| 3 Strava | `03-connect-strava` | same, plus missing-scope refusal; connects as the single activity source |
| 4 Terra | `04-connect-terra` | widget session → intercepted widget → signed `auth` webhook + redirect back; unsigned / bad-signature webhooks 401 |
| 5 Dashboard | `05-dashboard` | state, readiness score (0–100), **chart points**: ≥14 plotted EF circles, tooltip values from the seed (HRV 66–70); empty state |
| 6 Roster | `06-admin-roster` | all 11 accounts listed, latest state, drill-down to an athlete's full dashboard |
| 7 RBAC | `07-rbac` | plain user on `/admin*` gets a 3xx to `/dashboard` (raw request, `maxRedirects: 0`) and lands on the dashboard in a browser; API 403 on master-only routes and on another athlete's trends; forged `master` claim ignored; signed-out → `/login` / API 401 |
| 8 Disconnect | `08-disconnect` | cancel keeps it; confirm removes the connection and the HRV / resting-HR points leave the chart; Strava untouched |

Also confirmed on the built app: Next 16 recognises `middleware.ts` ("ƒ Proxy (Middleware)" in the
build output) and the `/admin` redirect works, so **no rename to `proxy.ts` is needed for behaviour**
(Next only labels it that way). `/admin` is additionally guarded in `admin/layout.tsx`.

## Product bugs found (tests kept, marked `test.fail()`)

1. **Disconnect leaves derived scores and state behind** — `08-disconnect` › "readiness score … is gone".
   `ConnectionService.disconnect` deletes `daily_metrics`, `activity_efforts` and config rows, but not
   `readiness_scores` / `trends`, and nothing recomputes them: `onSyncComplete` has no caller outside
   its own tests (the stage E wiring is missing). After disconnecting Oura the dashboard still shows the
   readiness score card and a "Fitness gain" state built from the deleted data. Verified the failure is
   exactly `getByRole('region', { name: 'Readiness score' })` still present. PLAN §12 says disconnect
   removes the data derived from the provider.
2. **Roster never shows sources or last sync** — `06-admin-roster` › "connected sources and last sync".
   `GET /users` returns only `{id,email,name,role,…}`; `fetchRoster` expects `connections`/`lastSyncAt`
   (its own comment says "not served yet"), so connected athletes read "None connected" / "Never".
3. **Bad credentials crash the login page** — `01-login` › "wrong password shows a sign-in error".
   `login/page.tsx` does not catch NextAuth's `CredentialsSignin`; the user gets Next's "This page
   couldn't load — A server error occurred" page instead of the form with a message. No session is
   created (that part is asserted by passing tests).

## Observations (not failing tests)

- **Terra's browser redirect never reaches the API.** The adapter's success URL is `/settings`, which
  only renders a status message, and `/settings/connections/[provider]/callback` requires `code`+`state`,
  which Terra's redirect (`user_id`, `reference_id`, `resource`) doesn't carry. The connection is
  recorded only by Terra's signed `auth` webhook, which is what flow 4 exercises. If the webhook is
  lost, the user returns to the app with nothing connected. Worth a decision (PLAN §5.3 calls the
  webhook the reliable twin).
- The hero chart legend lists HRV / Resting HR even when a series has no points (after disconnect), so
  flow 8 asserts on plotted data (tooltip), not the legend.
- `/dashboard` nests a `<main>` inside the layout's `<main>` (settings and admin pages do the same);
  harmless for these tests but an a11y landmark nit.
- Seeded data is `fitness_gain` by construction. Other quadrant states are covered by scoring-engine unit
  tests, not here.

## Selectors

Role/label/text selectors throughout. Two deliberate exceptions, because Recharts exposes no roles:
`figure.locator('svg circle')` to count plotted EF points, and `svg` bounding box for the hover.
Hydration-sensitive clicks (Connect, Disconnect) retry via `expect(...).toPass()` rather than sleeping.

## Needs from other phases

- **Integrator / 5b + 2:** call `FatigueFitnessService.onSyncComplete` after every ingest _and after
  disconnect_ (or delete `readiness_scores`/`trends` rows for the provider's user) — bug 1.
- **5b / 6b:** have `GET /users` return connections + `lastSyncAt` (or add a roster endpoint) — bug 2.
- **1 (auth UI):** catch `CredentialsSignin` in `login/page.tsx` and render an error — bug 3.
- **Root `.gitignore` / `.prettierignore`:** not needed; saved sessions live under the already-ignored
  `test-results/`.
- When bugs 1–3 are fixed, delete the `test.fail()` lines; the assertions are already written.

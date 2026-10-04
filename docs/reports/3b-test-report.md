# Phase 3b test report — Terra adapter

Result: **FAIL** (2 new tests fail; everything else green: typecheck, lint, 276 pre-existing tests).
`pnpm db:migrate` reported no pending migrations (phase 3b adds none).

## Spec coverage
| Requirement | Test | Status |
|---|---|---|
| Valid signature accepted | `signature.test.ts`, `webhook.test.ts` | pass |
| Tampered body rejected | both files | pass |
| Wrong secret rejected | both files | pass |
| Stale (and far-future) timestamp rejected | both files | pass |
| Unknown / non-UUID / missing reference_id ignored safely | `webhook.test.ts` | pass |
| Terra user_id mismatch / inactive connection ignored | `webhook.test.ts` | pass |
| Verify before parse (unsigned unparseable = 401, signed = 400) | `webhook.test.ts` | pass |
| Fail closed with no secret; refuse if json parser ran first | `webhook.test.ts` | pass |
| Receipt in webhook_events, metadata only (no raw payload) | `webhook.test.ts` | pass |
| Normalization from fixtures; idempotent upsert on redelivery | `terra.test.ts`, `webhook.test.ts` | pass |
| Widget session with reference_id; callback binds only own user | `terra.test.ts` | pass |
| One-time backfill on connect, no re-request, no poller (`fetchRaw` undefined), 429 handling | `terra.test.ts`, `webhook.test.ts` | pass |
| **POST /api/v1/webhooks/terra exists on the real app and gets the raw body** | `mount.test.ts` (new) | **FAIL** |

## Failures
- `apps/api/src/webhooks/terra/mount.test.ts:27` — expected 401 (unsigned request reaching the handler), got **404**.
- `apps/api/src/webhooks/terra/mount.test.ts:37` — expected 200 for a correctly signed request, got **404**.

Cause: `apps/api/src/app.ts` never mounts `terraWebhookRouter`. It also installs a global `express.json()` (line 9) before any route. If the router were simply mounted after that line, it would return 500 ("body parser misconfigured") for every request, because the raw bytes would already be consumed. The endpoint therefore does not exist in the running app. The existing `webhook.test.ts` passes only because it builds its own Express app.
Fix (outside this phase's ownership: app.ts is not 3b's): mount the router at `/api/v1/webhooks/terra` before `express.json()`. Also register the Terra adapter (`createTerraAdapter` with env credentials) in the default registry. Nothing in `apps/` outside the tests uses `createTerraAdapter`.

## Risks not tested
- Real Terra field names and the `data` array shape (the code itself says to re-verify against a live payload). No live calls are allowed.
- The widget-session start and callback routes are only tested at adapter level. No test runs them through the connection routes, because the adapter isn't registered in the app.
- Tokens/secrets never being logged: no log-capture test. I saw no logging in the reviewed code.
- Timing side channels in the constant-time compare were not measured.

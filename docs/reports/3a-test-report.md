# Phase 3a test report (Oura adapter)

Result: after `pnpm db:migrate`, `pnpm typecheck`, `pnpm lint` and `pnpm test` all pass (29 files, 280 tests). No product code was changed.

The builder implemented Oura webhooks and kept polling as the fallback. This report replaces an earlier version that said webhooks were not implemented.

## Spec coverage
| Requirement | Test | Status |
|---|---|---|
| OAuth2 code flow with state; denied or missing code | oura.test.ts start/callback | covered |
| Encrypted token storage via TokenCipher | sync-job.test.ts, webhook.test.ts (api) | covered |
| Refresh on expired token; 401 refresh-and-retry; grant kept if fetch fails | oura.test.ts; sync-job.test.ts; api webhook.test.ts | covered |
| Normalization to hrv, resting_hr, sleep_score, readiness (nulls, bad dates, naps, junk input) | oura.test.ts | covered |
| Incremental date range, first-sync lookback, pagination | oura.test.ts; sync-job.test.ts | covered |
| Idempotent upserts and replay | sync-job.test.ts; api webhook.test.ts | covered |
| `last_synced_at` unchanged on failure; NotConnected | sync-job.test.ts | covered |
| Sandbox mode without a ring | oura.test.ts | covered |
| 429 handling | oura.test.ts | covered |
| Tokens never logged or returned | oura.test.ts; sync-job-extra.test.ts; api webhook.test.ts | covered |
| Concurrency lock; per-user isolation in `syncOuraAll` | sync-job-extra.test.ts | covered |
| Webhook signature (HMAC over timestamp + body, constant-time, case, stale/replay, malformed) | adapters webhook.test.ts | covered |
| Webhook verification-token challenge | adapters and api webhook.test.ts | covered |
| Bad signature rejected before any fetch, receipt or row | api webhook.test.ts | covered |
| Webhook re-fetch of the affected collection; window widens to `last_synced_at`; delete events; unknown user; unmapped types; 500 so Oura retries; 503 while locked | api webhook.test.ts | covered |
| Subscription create, renew and idempotent ensure | adapters webhook.test.ts | covered |
| `handler` Lambda entrypoint and `ouraConfigFromEnv` | none | untested |

## Failures
None.

## Risks and gaps
- **Fixtures:** all tests use fixtures built from the OpenAPI excerpt in the repo (`openapi-1.41.json`). They cannot catch drift from the live API.
- **Endpoints:** `daily_activity` and `heartrate` are not fetched. The phase prompt listed them, but the four required metrics do not need them.
- **Entrypoints:** the `handler` entrypoint and the `subscriptions-job` entrypoint have no direct tests, because they build their dependencies from the environment.
- **Test setup:** the API tests need a migrated local Postgres.

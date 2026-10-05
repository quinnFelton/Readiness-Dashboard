# Phase 9 test report

Result: `pnpm db:migrate` (up to date), `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass (105 files, 917 tests). I added no new tests: the dev-written suite already covers each item below, and I checked the test names and some bodies, not every assertion.

## Spec coverage

| Requirement | Test |
|---|---|
| Export/delete authz (self or master, 403 other, unauthenticated, forged role, 404 unknown ids) | privacy/privacy.test.ts "authorization" |
| Export includes kept data from disconnected providers; no tokens; no other users; every column of every per-user table | privacy.test.ts "export" |
| Delete: confirmation required, revokes grants with decrypted tokens, failing revoke does not block, idempotent, isolation, last-master guard | privacy.test.ts "delete" and "last master guard" |
| Rate limiter (burst, 429 plus Retry-After, refill, bounded keys, CDK context config) | middleware/hardening.test.ts |
| Every route guarded, with an allowlist | routes-guarded.test.ts |
| No token/secret/payload logging | logging-audit.test.ts, hardening.test.ts (safe error handler) |
| webhook_events TTL job (phase 8) | Only referenced in lambda.test.ts and api-stack.test.ts (checked by grep, not read in full). I did not read the cleanup handler's own test. |
| RDS-CA verifying `ssl` in pool | lambda/lambda.test.ts (`toPgSsl`, `sslFromEnv`, and no sslmode in the DATABASE_URL) |
| Per-function Postgres roles | lambda/db-roles.test.ts (812 lines, against a real DB) |
| First-master guarded path | lambda/first-master.test.ts (refuses once a master exists, least-privilege role) |
| Strava replay retry cap and terminal status | webhooks/strava/replay-cap.test.ts |
| History rebuild (idempotent, bounded) | fatigue-fitness/history-rebuild.test.ts |
| `syncUser` / `syncAll` call the recompute hook | sync/sync-recompute.test.ts |
| `GET /users` includes latest state | users/roster-state.test.ts |
| Concurrent classifier promotion returns 409 | comparison/promotion-race.test.ts |
| Settings fixes (rapid toggles, unconnected provider) | web connections-panel-selection.test.tsx |
| Chart legend and nested `<main>` | legend.test.tsx, landmarks.test.ts |
| NEXTAUTH_SECRET read at runtime | web prod-auth.test.ts, plus CDK web-obs-oidc.test.ts |
| CDK changes | infra/cdk/test/* |

## Not verified or untested

- COST.md figures and the AWS pricing URLs were not independently checked. I did not use WebFetch.
- Master password rotation: I could only check the CDK assertions that exist. I could not confirm real rotation behaviour.
- Real Lambda, RDS TLS and KMS behaviour was not exercised. All tests are local or mocked.
- Open question, not decided: a lost Terra `auth` webhook means no connection is recorded (PLAN §5.3).

I treated `passed` as true because every test passes and each requirement has a test, but the webhook-ttl row above is only partly checked.

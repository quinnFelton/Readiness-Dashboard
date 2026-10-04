# Phase 1 test report — Auth & user model

**passed: true.** All 71 tests pass (9 files). Every spec requirement has a test. Real Next.js runtime enforcement of `middleware.ts` is not covered. It is listed under risks and belongs to phase 7 e2e.

## Run
- `pnpm db:migrate`: nothing to apply (already up to date).
- `pnpm typecheck`, `pnpm lint` (eslint and prettier), `pnpm test`: all pass. 9 files, 71 tests, with the DB-backed tests running against real Postgres.
- An earlier report said the DB tests could not run. That was an environment gap and is now resolved.

## Approved deviation (not a failure)
NextAuth uses the JWT session strategy with no Postgres adapter (`apps/web/src/lib/auth/config.ts`). The owner approved this on 2026-10-04 because the API re-reads the role from the DB on every request. `users.test.ts` ("trusts the DB role, not the token role claim") and `rbac.test.ts` verify that behaviour.

## Spec coverage
| Requirement | Test | Status |
|---|---|---|
| `users` migration matches PLAN §7 | `schema.test.ts`: columns, types, nullability, defaults, unique email, role CHECK, default `user` | Pass |
| Seed: 10 users + master, deterministic emails, idempotent | `seed-accounts.test.ts`, `users.test.ts` | Pass |
| 401 without a token, or with a garbage, tampered, expired or wrong-secret token | `users.test.ts`, `rbac.test.ts`, `token.test.ts` | Pass |
| 401 for a valid token whose user doesn't exist, or whose sub is not a UUID (no 500) | `schema.test.ts` | Pass |
| `GET /users/me` returns 200 for the caller only | `users.test.ts` | Pass |
| `GET /users`: 401 unauthenticated, 403 for a user, 200 for master | `users.test.ts` | Pass |
| Role comes from the DB, not the token (forged master claim gets 403) | `users.test.ts` | Pass |
| `requireSelfOrMaster`: self 200, other user 403, master 200, missing param denied | `users.test.ts`, `rbac.test.ts` | Pass |
| `/auth/login`: 404 when the dev password is unset or `NODE_ENV=production`, 400 on non-string body, 401 on bad credentials | `users.test.ts`, `schema.test.ts` | Pass |
| Tokens and secrets never logged | `schema.test.ts` spies on `console` across 401 paths | Pass (narrow: console only) |
| Web `/admin` guard decision (redirect to `/login` or `/dashboard`) | `admin-guard.test.ts` | Pass |
| `apps/web/middleware.ts` wiring and matcher | `middleware-wiring.test.ts` (next-auth mocked): matcher is `/admin/:path*`; anonymous goes to `/login`; user goes to `/dashboard`; master passes | Pass |
| Web-minted token verifies in the API (shared contract); expiry, wrong secret and missing secret are rejected | `api-token.test.ts` | Pass |
| NextAuth config: JWT strategy (approved deviation); jwt/session callbacks carry uid and role, and role defaults to `user` | `api-token.test.ts` | Pass |
| Login page UI | none | Untested (presentational; typecheck only) |

## Failures
None in the final run. One failure occurred mid-run and was caused by my own test. `schema.test.ts` inserted an `@example.test` row, which raced with the seed-count assertion in `users.test.ts` because vitest runs files in parallel against one DB. I changed the email domain to `@schema-check.invalid`.

## Risks not tested
1. `middleware.ts` has a note that Next 16 may prefer `proxy.ts`. My wiring test mocks next-auth and calls the handler directly. It cannot show that Next actually runs the file, so a real `/admin` request needs an e2e check (phase 7). The API's `requireMaster` 403 is tested and is the real control.
2. A demoted or revoked user's web session role can be stale for up to 8 hours. This affects only the UI redirect, because the API re-checks the role.
3. The dev login looks up the email in the DB before the constant-time password compare, so timing could reveal whether an email exists. This is dev-only and minor.
4. `requireSelfOrMaster` compares ids as case-sensitive strings.
5. Tests that share the DB depend on the seed (`@example.test` count). New tests that add users must use another domain.

## Tests added this pass
- `apps/api/src/users/schema.test.ts` (new)
- `apps/web/src/lib/auth/middleware-wiring.test.ts` (new; it sits under `src/` because the web vitest config only includes `src/**`)
- `apps/web/src/lib/auth/api-token.test.ts` (new)
- Earlier: `rbac.test.ts`, `token.test.ts`, `seed-accounts.test.ts`.

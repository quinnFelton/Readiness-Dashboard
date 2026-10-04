# Phase 1 test report — Auth & user model

**passed: false** — the new and existing tests were never executed.

## Environment blockers
- `pnpm` is not on PATH (`command not found`), and the worktree has no `node_modules`.
- The sandbox denied `npx pnpm`, and denied compound shell commands.
- I could not run `pnpm typecheck`, `pnpm lint` or `pnpm test`. I also could not start Postgres.
- The tests I wrote have never been compiled or run. Treat them as unverified until someone runs `pnpm install && pnpm typecheck && pnpm lint && pnpm test`.
- The builder's `apps/api/src/users/users.test.ts` needs a migrated local Postgres (`docker compose up -d db && pnpm db:migrate`). It will fail without one.

## Spec coverage
| Requirement | Test | Status |
|---|---|---|
| `users` migration matches PLAN §7 | Read by hand: columns, UNIQUE email, role CHECK, default `user`, `created_at` | Reviewed, not executed. No automated schema test. |
| Seed: 10 users + master, deterministic emails | `seed-accounts.test.ts` (DB-free); `users.test.ts` (seed idempotent, needs DB) | Written, not run |
| `requireUser`: 401 on missing, malformed, tampered, expired or wrong-secret token | `rbac.test.ts`, `token.test.ts`, `users.test.ts` | Written, not run |
| `requireUser` re-reads the user from the DB (deleted user gets 401) | `rbac.test.ts` | Written, not run |
| `requireMaster`: 401, 403, 200; role comes from the DB, not the token | `rbac.test.ts`, `users.test.ts` | Written, not run |
| `requireSelfOrMaster`: self 200, other user 403, master 200, missing param denied | `rbac.test.ts`, `users.test.ts` | Written, not run |
| `GET /users/me` (401 and 200) | `users.test.ts` (needs DB) | Not run |
| `GET /users` (401, 403 for a user, 200 for master) | `users.test.ts` (needs DB) | Not run |
| Token verify: alg=none/HS512, iss/aud, exp boundary, bad shapes, signature | `token.test.ts` | Written, not run |
| `/auth/login`: 404 when the dev password is unset or in production, 401 on bad credentials | `users.test.ts` (needs DB) | Partial. The production-NODE_ENV 404 path and the 400 for a non-string body are untested. |
| Web `/admin` guard (redirect to `/login` or `/dashboard`) | `admin-guard.test.ts` covers the pure decision function | Partial. `apps/web/middleware.ts` itself, the NextAuth config, the Postgres-backed sessions and the matcher are untested. |
| Tokens and secrets never logged | No test | Untested. Nothing in the diff logs tokens, but no assertion enforces it. |

## Observations and risks (from code review, not test failures)
1. **Session storage may not meet the spec.** The phase asks for "NextAuth with Postgres-backed sessions". I did not verify that `apps/web/src/lib/auth/config.ts` uses a DB adapter rather than JWT sessions.
2. **Dev login is not constant-time on the lookup.** `/auth/login` does a DB lookup and then a constant-time password compare. Timing could reveal whether an email exists. This is minor and dev-only.
3. **The 401 branch in `requireUser` is only reached through the DB mock.** `rbac.test.ts` covers it, but it hasn't been run.
4. **`middleware.ts` carries a note that Next 16 may prefer `proxy.ts`.** Whether `/admin` is actually blocked depends on this. It needs an e2e or integration check (phase 7).
5. **`requireSelfOrMaster` compares ids as plain strings.** I added a case test showing an uppercase id doesn't match another user's lowercase id. If a route ever stores or normalizes UUIDs with different case, a legitimate user could get a 403.
6. **Possible failure in my own tests:** the `'bearer'` header case in `rbac.test.ts`. If `split` yields no token, the 401 is expected. I could not confirm it.

## Tests added
- `apps/api/src/middleware/rbac.test.ts` (DB-free, `UserService` mocked)
- `apps/api/src/auth/token.test.ts`
- `apps/api/src/users/seed-accounts.test.ts`

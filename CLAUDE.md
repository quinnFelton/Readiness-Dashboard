# Readiness Dashboard — instructions for Claude Code

Personal multi-user dashboard comparing Power:HR efficiency (EF) trend against recovery
context (HRV, resting HR) to separate fitness gains from fatigue. **PLAN.md is the spec.**
Read the sections your task references before writing code. If the plan and this file
disagree, this file wins on *process*; PLAN.md wins on *product behavior*.

## Stack
pnpm workspaces monorepo · TypeScript (strict) everywhere · Next.js App Router + Tailwind +
Recharts (`apps/web`) · Express wrapped with `serverless-http` (`apps/api`) · Postgres
(local: Docker; prod: Aurora Serverless v2) · NextAuth · Vitest (unit) · Playwright (e2e) ·
AWS CDK (`infra/cdk`) · GitHub Actions.

## Layout
```
apps/web            Next.js frontend
apps/api            Express REST API + webhook handlers + sync jobs
apps/api/db/migrations   SQL migrations (node-pg-migrate)
packages/shared-types     Shared TS types (one file per domain, re-exported from index.ts)
packages/scoring-engine   PURE functions: NP, peak-20, EF, baselines, quadrant classifier
packages/provider-adapters  oura.ts, strava.ts, terra.ts — ProviderAdapter<T> by role
infra/cdk           CDK stacks
tests/e2e           Playwright specs
pipeline/           Build pipeline scripts + phase prompts (see pipeline/README.md)
docs/OWNERSHIP.md   Which phase may edit which paths — READ BEFORE EDITING
```

## Commands (run from repo root)
- `pnpm install`
- `pnpm typecheck` · `pnpm lint` · `pnpm test` (Vitest, all packages) · `pnpm test:e2e`
- `pnpm --filter @rd/scoring-engine test` — run one package's tests
- `docker compose up -d db` — local Postgres; `pnpm db:migrate` — apply migrations
- Package names use the `@rd/` scope (e.g. `@rd/api`, `@rd/web`, `@rd/shared-types`).

## Non-negotiable rules
1. **Scoring engine is pure.** `packages/scoring-engine` has zero AWS, DB, network, or
   Date.now() dependencies. Inputs in, numbers out. It is the highest-value code in the
   repo; every function gets Vitest coverage with hand-checkable fixtures (PLAN §8.5).
2. **peak20 HR must come from the same window as peak20 power.** Never use whole-ride HR.
   Use a prefix-sum sliding window (O(n)).
3. **RBAC server-side on every endpoint.** UI hiding is never the control.
4. **Every table has `user_id`.** Upserts are idempotent (`ON CONFLICT ... DO UPDATE`) on
   the natural keys in PLAN §7. Only exception: global method registries that hold no one's
   data (`derivers`, `classifiers`, PLAN §8.7/§8.8). Anything per-person needs `user_id`.
5. **No raw streams or payloads in main tables.** Derive scalars, discard source data.
   Bump `derivation_version` when derivation logic changes.
6. **Never log tokens, secrets, or raw health payloads** above DEBUG. Tokens are encrypted
   at rest (KMS in prod; a local AES key from `.env` in dev behind the same interface).
7. **Verify Terra signatures before touching the payload** (PLAN §5.3), constant-time compare.
8. **Don't hardcode third-party field names from memory.** Fetch current docs for Terra,
   Oura, and Strava (WebFetch) and cite the doc URL in a code comment next to the mapping.
9. **Thresholds are config, not constants** (z-score dead zone, min activity duration,
   source precedence).
10. **Mock all third-party HTTP in tests.** No test hits Oura/Strava/Terra/AWS.

## Git workflow
- Never commit to or push `main`. Work on the branch you were given (pipeline runs are
  already checked out on the right branch in their own worktree — don't switch branches).
- Small commits, Conventional Commit messages: `feat(api): ...`, `test(scoring-engine): ...`.
- Commit after each meaningful working step, not just at the end; the pipeline pushes.
- Before your final commit: `pnpm typecheck && pnpm lint && pnpm test` must pass for the
  packages you touched. If something can't pass, say exactly why in your final message.
- Only edit paths your phase owns (docs/OWNERSHIP.md). If you need a change outside them,
  put it in your final report under "Needs from other phases" instead of making it.
- Shared hot spots (root package.json, lockfile, shared-types/index.ts, migrations): make the
  minimal additive change; the integrator resolves merge conflicts there.
- Migrations: one file per phase, named `<timestamp>_phase-<id>_<name>.sql`.

## Definition of done (every task)
Code + tests for what you built, typecheck/lint/tests green, PLAN references in comments for
non-obvious logic, and a final message containing: what was built, files changed, how it was
tested, open questions, and "Needs from other phases".

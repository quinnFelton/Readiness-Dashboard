# File ownership by phase

Parallel agents only stay out of each other's way if each one edits a known set of paths.
An agent may **read** anything, but may only **edit** the paths listed for its phase.
Anything else goes in its final report under "Needs from other phases".

| Phase | Branch | May edit |
|---|---|---|
| 0 Scaffold | `phase-0/scaffold` | everything (it creates the skeleton) |
| 1 Auth & users | `phase-1/auth` | `apps/api/src/auth/**`, `apps/api/src/users/**`, `apps/api/src/middleware/**`, `apps/web/src/app/(auth)/**`, `apps/web/src/lib/auth/**`, `apps/web/middleware.ts`, `packages/shared-types/src/user.ts`, migration `*_phase-1_*`, `apps/api/db/seed/**` |
| 2 Connection framework | `phase-2/connections` | `apps/api/src/connections/**`, `apps/api/src/sync/**`, `apps/api/src/crypto/**`, `packages/provider-adapters/src/{types,registry,index}.ts`, `packages/shared-types/src/{connection,metrics}.ts`, migration `*_phase-2_*` |
| 5a Scoring engine | `phase-5a/scoring-engine` | `packages/scoring-engine/**` |
| 3a Oura | `phase-3a/oura` | `packages/provider-adapters/src/oura/**`, `apps/api/src/providers/oura/**`, migration `*_phase-3a_*` |
| 3b Terra | `phase-3b/terra` | `packages/provider-adapters/src/terra/**`, `apps/api/src/providers/terra/**`, `apps/api/src/webhooks/terra/**`, migration `*_phase-3b_*` |
| 4 Strava | `phase-4/strava` | `packages/provider-adapters/src/strava/**`, `apps/api/src/providers/strava/**`, `apps/api/src/webhooks/strava/**`, `apps/api/src/efforts/**`, migration `*_phase-4_*` |
| 5b Classifier service | `phase-5b/classifier-service` | `apps/api/src/trends/**`, `apps/api/src/scores/**`, `apps/api/src/fatigue-fitness/**`, migration `*_phase-5b_*` |
| 6a Dashboard UI | `phase-6a/dashboard` | `apps/web/src/app/dashboard/**`, `apps/web/src/components/charts/**`, `apps/web/src/components/dashboard/**` |
| 6b Admin UI | `phase-6b/admin` | `apps/web/src/app/admin/**`, `apps/web/src/components/admin/**` |
| 6c Connections UI | `phase-6c/connections-ui` | `apps/web/src/app/settings/**`, `apps/web/src/components/settings/**` |
| 7 E2E | `phase-7/e2e` | `tests/e2e/**`, `playwright.config.ts` |
| 8 Infra | `phase-8/infra` | `infra/cdk/**`, `.github/workflows/deploy*.yml` |
| 9 Hardening | `phase-9/hardening` | `apps/api/src/privacy/**`, plus targeted fixes anywhere, each listed in its report |

All builder phases may also add **tests next to the code they own** and append one
re-export line to `packages/shared-types/src/index.ts`.

Testers (`module-tester`) only edit `**/*.test.ts`, `**/__fixtures__/**`, and
`docs/reports/**` on the branch they are testing.

The integrator may edit anything needed to resolve conflicts and get the integration
branch green, and must list every non-trivial edit in its PR description.

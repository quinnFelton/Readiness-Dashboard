# Phase 5b test report

Ran `pnpm db:migrate`, then `pnpm typecheck && pnpm lint && pnpm test`: all green (53 files, 510 tests).
No new tests were needed. The phase's own tests already cover every spec item (reviewed by reading the test names and the routes).

| Requirement | Test |
|---|---|
| Trigger fires only when both trends exist (either sync) | fatigue-fitness/service.test.ts (3 tests) |
| Daily-metric precedence, never averaged | service.test.ts precedence block |
| Recompute idempotent for every classifier | service.test.ts |
| Two classifiers give two rows per window | service.test.ts |
| Only default-deriver efforts feed EF | service.test.ts |
| DB default not registered in code fails loudly | service.test.ts, trends/routes.test.ts |
| readiness_scores idempotent | service.test.ts, scores/readiness-blend.test.ts |
| Default-only rows for users, ?classifier gated to master (403 for a user) | trends/routes.test.ts |
| A user can't read another user's trends/scores | trends/routes.test.ts |
| Feedback upsert idempotent, vote validation, 404 for a non-existent trend | feedback/feedback.test.ts |
| Athlete-event CRUD isolated per user, cascade delete (§12) | feedback/feedback.test.ts |
| Cross-user read/write is 403, 401 anonymous | comparison/authz.test.ts |
| Comparison routes 403 for non-masters (role from the DB) | authz.test.ts, comparison.test.ts |
| Backtest numbers against a hand-checked fixture | scoring-engine/src/backtest.test.ts, comparison.test.ts |
| Promotion leaves exactly one default, unregistered id refused | comparison.test.ts, authz.test.ts |
| Notes and comments never logged | authz.test.ts |

## Risks not tested
- Concurrent promotion races (409 path) are not exercised.
- The routers are not mounted in app.ts (integrator's job), so there is no end-to-end HTTP test through the real app.
- Only the feedback comment's log safety was checked by name. I did not confirm that athlete-event `notes` have a dedicated no-logging test.

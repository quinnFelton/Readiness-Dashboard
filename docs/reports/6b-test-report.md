# Phase 6b test report

Result: typecheck, lint and the full suite pass (455 tests, 49 files). `pnpm db:migrate` ran clean.

I added `apps/web/src/app/admin/admin-server.test.tsx`. The author's `admin.test.tsx` and `admin-guard.test.ts` already existed.

## Spec coverage
| Requirement | Test |
|---|---|
| Roster has name, sources, state and last sync, and is sortable | `admin.test.tsx` (sortRoster, RosterTable) |
| overreaching_risk is pinned first for every sort key and direction | `admin.test.tsx` |
| Roster takes latest state from /trends and survives one athlete's failure | `admin-server.test.tsx` |
| Last sync is the max across connections | `admin-server.test.tsx` |
| Server-side role enforcement: guard and middleware | `admin-guard.test.ts`, `middleware-wiring.test.ts` |
| Server-side role enforcement: server action | `admin-server.test.tsx`: non-master and anonymous are redirected with no API call; the action does not revalidate when the API returns 403 |
| API 403 surfaces as ApiError | `admin-server.test.tsx` |
| Nav entry hidden for non-master | `admin.test.tsx` |
| Classifier table columns and default badge | `admin.test.tsx` |
| Date-range selector | `range-selector.test.tsx` (renders all ranges, parseRange fallback); link navigation not browser-tested |
| "Make default" confirmation explains the effect | `admin.test.tsx` |
| Promote calls PUT with the id URL-encoded | `admin-server.test.tsx` |
| Derivers list is read-only with a default badge | `admin.test.tsx` |
| `?classifier=` selector, with a warning when non-default | `admin.test.tsx` |
| Drill-down forwards a known classifier and ignores an unknown one | `admin-server.test.tsx` |
| Drill-down renders the athlete dashboard | Placeholder only |

## Failures
None.

## Risks and untested items
- 6a's `AthleteDashboard` is not on main. The drill-down renders `AthleteDashboardSlot`, a placeholder, so the integrator must wire it. Nothing yet shows that `?classifier=` changes any trends data.
- Phase 5b's comparison routes are not on this branch (`apps/api/src/comparison` is missing). The response shapes are mocked from `pipeline/phases/5b.md` and not checked against the real routes. API-side 403 for the comparison routes belongs to phase 5b's tests.
- `GET /users` does not return connections, last sync or latest state. The roster makes one `/trends/:id` call per user, which scales poorly (N+1).
- The roster takes the latest state from `/trends/:userId` rows that have `metricType === 'fatigue_fitness_state'`. This was not checked against the real 5b output.
- `middleware.ts` may need to be `proxy.ts` on Next 16, and I did not run the app. No e2e or browser test covers the `<dialog>` confirm flow, so jsdom only checks the dialog text.
- Several of these items would need a running API or browser to check.

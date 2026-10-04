# Phase 5a test report — scoring engine

**passed: true** — typecheck, lint and all 115 tests (10 files) are green. Every spec requirement has an automated test; the O(n) check is timing-only (see Risks).

## Results
- `pnpm install --offline --frozen-lockfile` was needed first because `node_modules` was missing in this worktree.
- `pnpm test`: 9 files, 107 tests, all pass (101 earlier + 6 in `edge.test.ts`).
- `pnpm typecheck`: clean.
- `pnpm lint`: clean (eslint and prettier). An earlier version of this report said lint failed on `classifier.ts` and `effort.ts`. That is stale: prettier passes on the current tree.

## Spec coverage
| Requirement | Test |
|---|---|
| NP: 30 s rolling → ^4 → mean → ^¼, hand-computed (§8.1) | power.test.ts |
| peak20 isolated in junk miles; HR from the same window (rule 2) | power.test.ts, effort.test.ts |
| Prefix-sum O(n) | public-api.test.ts (timing check only, weak) |
| avg power/HR, EF overall and peak20, hand value 200/150 | effort.test.ts, public-api.test.ts |
| ≥20 min qualification boundary, coverage rejects, null peak20 HR | effort.test.ts |
| Sparse EF, multi-ride days kept separate (§8.2, §8.4) | baseline.test.ts, scenarios.test.ts |
| 7d/28d means, sample stddev, z, no-data nulls, flat baseline | baseline.test.ts |
| Window edges: age 6 is in short, age 7 is long only, age 28 is out, future dates ignored; hand z = −0.5 | edge.test.ts (new) |
| Impossible dates (2026-02-30) rejected | edge.test.ts (new) |
| Recovery sign convention (HRV up and RHR down = recovered), single-signal abstain | edge.test.ts (new), classifier.test.ts |
| Four quadrants plus flat-EF case | classifier.test.ts |
| Dead zone is config; boundary counts as flat (§17, rule 9) | classifier.test.ts |
| HR-drift multi-day scenarios → acute_fatigue / overreaching_risk (§8.5) | scenarios.test.ts |
| No HRV → abstain (§8.5) | classifier.test.ts, scenarios.test.ts |
| Public API exports and `DERIVATION_VERSION` | public-api.test.ts |
| Inputs not mutated, deterministic | public-api.test.ts |
| No Date.now / network / apps/* imports (rule 1) | purity.test.ts (new; scans raw product sources with comments stripped) |

## Failures
None.

## Risks / untested
- The README's formulas and defaults were not machine-checked against the code.
- The flat-EF → `ambiguous` mapping is an assumption not defined in PLAN §8.3. The code flags it for Quinn to confirm.
- There is no external NP comparison, for example against TrainingPeaks.
- The O(n) performance check is a timing test and does not prove complexity.

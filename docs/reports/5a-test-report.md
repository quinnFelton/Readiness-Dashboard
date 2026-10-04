# Phase 5a test report — scoring engine

**passed: false** — all 101 tests pass and typecheck is clean, but `pnpm lint` fails (see Failures).

## Results
- `pnpm test`: 8 files, 101 tests, all pass (97 pre-existing + 4 added in `public-api.test.ts`).
- `pnpm typecheck`: clean.
- `pnpm lint`: **fails** on Prettier for product files `packages/scoring-engine/src/classifier.ts` and `effort.ts`.

## Spec coverage
| Requirement | Test |
|---|---|
| NP: 30 s rolling → ^4 → mean → ^¼, hand-computed (§8.1) | power.test.ts (31 s, 60 s step, steady, 2 Hz vs 1 Hz) |
| peak20 isolated in junk miles; HR from the same window (rule 2) | power.test.ts, effort.test.ts fixture 2 |
| Prefix-sum O(n) | public-api.test.ts (3 h ride under 1 s; a weak timing check, not proof of complexity) |
| avg power/HR, EF overall and peak20, hand value 200/150 | effort.test.ts, public-api.test.ts |
| ≥20 min qualification boundary, coverage rejects, null peak20 HR | effort.test.ts |
| Sparse EF, multi-ride days kept separate (§8.2, §8.4) | baseline.test.ts, scenarios.test.ts |
| 7d/28d mean, sample stddev, z, no-data nulls, flat baseline | baseline.test.ts |
| Four quadrants plus flat-EF case | classifier.test.ts |
| Dead zone is config; boundary counts as flat (§17, rule 9) | classifier.test.ts |
| HR-drift multi-day fixture → acute_fatigue / overreaching_risk (§8.5) | scenarios.test.ts |
| No HRV → abstain (§8.5) | classifier.test.ts, scenarios.test.ts |
| Public API exports and `DERIVATION_VERSION` | public-api.test.ts |
| Inputs not mutated, deterministic | public-api.test.ts |
| No Date.now or apps/* imports | Checked by grep of product sources: none found (a comment in index.ts mentions Date.now). Not enforced by a test, because the package has no node types. |

## Failures
1. `pnpm lint` → `prettier --check .` flags `packages/scoring-engine/src/classifier.ts` and `packages/scoring-engine/src/effort.ts`. Expected: formatted. Actual: style warnings. I can't edit product code. The builder needs to run `pnpm exec prettier --write` on those two files. I formatted `baseline.test.ts` and `effort.test.ts` myself, since they are test files.

## Risks / untested
- The README's documented formulas and defaults were not machine-checked against the code.
- The flat-EF → `ambiguous` mapping is an assumption not covered by PLAN §8.3 (the code flags it for confirmation).
- A real-ride NP comparison against an external tool (e.g. TrainingPeaks) is not available.
- The pipeline's final `pnpm install` was done with `--offline --frozen-lockfile`.

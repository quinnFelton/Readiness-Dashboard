# Build pipeline

Each phase in PLAN §16 runs as its own headless Claude Code session (`claude -p --agent <role>`)
in its own git worktree on its own branch. A separate tester agent then reviews and tests that
branch; failures go back to the builder once. An integrator merges the stage's branches into
`integration/stage-<X>`, gets the full suite green, pushes, and opens a PR to `main`.
**You review and merge that PR before starting the next stage** — that's your checkpoint.

```
Stage A  phase 0 (scaffold)                         run interactively, merge to main
Stage B  [1 → 2]  ‖  5a scoring engine               → tests → integrate → PR
Stage C  3a Oura ‖ 3b Terra ‖ 4 Strava               → tests → integrate → PR
Stage D  5b classifier svc ‖ 6a dash ‖ 6b admin ‖ 6c settings → tests → integrate → PR
Stage E  7 e2e ‖ 8 infra (synth only)                → tests → integrate → PR
Stage F  security review → 9 hardening               → tests → integrate → PR
```
(`‖` = parallel, `→` = sequential.) The scoring engine is pulled forward into stage B because it's
pure and independent, so Strava (stage C) can call it instead of reimplementing the math.

## Commands
```bash
pipeline/run-stage.sh B            # whole stage
pipeline/run-phase.sh 3a           # just build one phase
pipeline/test-phase.sh 3a          # just test one phase (with one fix round)
pipeline/integrate.sh C phase-3a/oura phase-3b/terra phase-4/strava
DRY_RUN=1 pipeline/run-stage.sh C  # print what would run, no Claude calls
```
Environment knobs: `PERMISSION_MODE=auto` (default `acceptEdits`), `FIX_ROUNDS=0|1|2`,
`KEEP_WORKTREES=1`, `WT_ROOT=/path/for/worktrees`.

Logs (JSON incl. estimated cost and session_id) land in `pipeline/logs/`. To continue a session
by hand: `claude --resume <session_id>` from that phase's worktree.

## Changing the plan
- Cross-phase wiring for a stage goes in `pipeline/notes/integrate-<stage>.md`; integrate.sh passes it to the integrator.
- Add or reorder phases in `manifest.tsv` (id, agent, branch, base) and add `phases/<id>.md`.
- Edit stage composition in `run-stage.sh` (the `case` block).
- Update `docs/OWNERSHIP.md` whenever you add a phase, or parallel agents will collide.

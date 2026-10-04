#!/usr/bin/env bash
# Run a whole stage: build phases (parallel where safe) -> test each -> integrate -> PR.
# Stages must run in order, and you merge each stage's PR to main before the next one,
# because new phase branches start from main.
# Usage: pipeline/run-stage.sh <B|C|D|E|F>
source "$(dirname "$0")/lib.sh"
require_tools
stage="${1:?usage: run-stage.sh <B|C|D|E|F>}"
P="$PIPE"
export SKIP_FETCH=1
[ "$DRY_RUN" = 1 ] || git -C "$ROOT" fetch origin --quiet

build_and_test() { "$P/run-phase.sh" "$1" && "$P/test-phase.sh" "$1"; }

# run_parallel <job>... ; each job is a phase id or "a>b" for a sequential chain
run_parallel() {
  local pids=() names=() fail=0
  for job in "$@"; do
    ( IFS='>'; for id in $job; do build_and_test "$id" || exit 1; done ) &
    pids+=($!); names+=("$job")
    sleep 3   # stagger worktree creation
  done
  for i in "${!pids[@]}"; do
    if wait "${pids[$i]}"; then log "job ${names[$i]} OK"; else log "job ${names[$i]} FAILED"; fail=1; fi
  done
  return $fail
}

branches_for() { for id in "$@"; do phase_meta "$id" | cut -d' ' -f2; done; }

case "$stage" in
  B) ids=(1 2 5a); run_parallel "1>2" 5a ;;
  C) ids=(3a 3b 4); run_parallel 3a 3b 4 ;;
  D) ids=(5b 6a 6b 6c); run_parallel 5b 6a 6b 6c ;;
  E) ids=(7 8); run_parallel 7 8 ;;
  F) ids=(9)
     if [ "$DRY_RUN" != 1 ]; then
       wt="$(prepare_worktree phase-9/hardening main)"
       run_claude "$wt" security-reviewer "Audit the whole repository per your instructions. Write docs/reports/security-review.md and commit it with git add/commit." "security-review" >/dev/null
       push_and_cleanup "$wt" phase-9/hardening
     fi
     run_parallel 9 ;;
  *) die "unknown stage '$stage' (B, C, D, E, F; phase 0 is run on its own — see pipeline/README.md)" ;;
esac || die "stage $stage had failures; fix or rerun the failing phase, then run: pipeline/integrate.sh $stage $(branches_for "${ids[@]}" | tr '\n' ' ')"

"$P/integrate.sh" "$stage" $(branches_for "${ids[@]}")

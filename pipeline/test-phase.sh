#!/usr/bin/env bash
# Independently test one built phase on its branch. Exits 0 if passed, 1 if not.
# With FIX_ROUNDS>0 (default 1), failures are sent back to the builder, then retested.
# Usage: pipeline/test-phase.sh <phase-id>
source "$(dirname "$0")/lib.sh"
require_tools
id="${1:?usage: test-phase.sh <phase-id>}"
meta="$(phase_meta "$id")" || exit 1
[ -f "$PIPE/phases/$id.md" ] || die "missing phase prompt pipeline/phases/$id.md"
read -r agent branch base <<<"$meta"
FIX_ROUNDS="${FIX_ROUNDS:-1}"
schema='{"type":"object","properties":{"passed":{"type":"boolean"},"summary":{"type":"string"}},"required":["passed","summary"]}'

test_once() {
  [ "${SKIP_FETCH:-0}" = 1 ] || [ "$DRY_RUN" = 1 ] || git -C "$ROOT" fetch origin --quiet
  local wt out prompt
  wt="$(prepare_worktree "$branch" "$base")"
  prompt="You are testing phase $id. The phase prompt was:

$(cat "$PIPE/phases/$id.md")

Follow your module-tester instructions. Write the report to docs/reports/$id-test-report.md. Only edit test files and that report. Do not switch branches or push.
Before running tests, apply this branch's migrations with \`pnpm db:migrate\` (DATABASE_URL is already set)."
  # TEST_NOTES: owner decisions (e.g. approved spec deviations) the tester must honor.
  [ -z "${TEST_NOTES:-}" ] || prompt="$prompt

## Owner decisions (approved; do not fail the phase on these)
$TEST_NOTES"
  out="$(run_claude "$wt" module-tester "$prompt" "phase-$id-test" --json-schema "$schema")" || return 2
  push_and_cleanup "$wt" "$branch"
  local passed summary
  passed="$(jq -r '.structured_output.passed // false' "$out")"
  summary="$(jq -r '.structured_output.summary // "no summary"' "$out")"
  log "phase $id test result: passed=$passed — $summary"
  [ "$passed" = true ]
}

round=0
until test_once; do
  [ $? -eq 2 ] && die "tester for phase $id crashed; see pipeline/logs"
  if [ "$round" -ge "$FIX_ROUNDS" ]; then
    log "phase $id still failing after $FIX_ROUNDS fix round(s); see docs/reports/$id-test-report.md on $branch"
    exit 1
  fi
  round=$((round+1))
  log "phase $id: sending failures back to the builder (round $round)"
  "$PIPE/run-phase.sh" "$id" "An independent tester found problems. Read docs/reports/$id-test-report.md on this branch and fix every failure in product code. Do not weaken or delete the tester's tests; if you believe a test is wrong, explain why in your final message."
done

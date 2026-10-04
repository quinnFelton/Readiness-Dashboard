#!/usr/bin/env bash
# Build one phase in its own worktree, then push its branch.
# Usage: pipeline/run-phase.sh <phase-id> ["extra instructions"]
source "$(dirname "$0")/lib.sh"
require_tools
id="${1:?usage: run-phase.sh <phase-id> [extra]}"; extra="${2:-}"
meta="$(phase_meta "$id")" || exit 1
[ -f "$PIPE/phases/$id.md" ] || die "missing phase prompt pipeline/phases/$id.md"
read -r agent branch base <<<"$meta"
[ "${SKIP_FETCH:-0}" = 1 ] || [ "$DRY_RUN" = 1 ] || git -C "$ROOT" fetch origin --quiet
wt="$(prepare_worktree "$branch" "$base")"
run_claude "$wt" "$agent" "$(phase_prompt "$id" "$extra")" "phase-$id-build" >/dev/null
push_and_cleanup "$wt" "$branch"

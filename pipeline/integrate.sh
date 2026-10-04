#!/usr/bin/env bash
# Merge a stage's branches into integration/stage-<name>, get it green, push, open a PR.
# Usage: pipeline/integrate.sh <stage-name> <branch> [<branch>...]
source "$(dirname "$0")/lib.sh"
require_tools
stage="${1:?usage: integrate.sh <stage> <branches...>}"; shift
[ $# -gt 0 ] || die "no branches given"
branch="integration/stage-$stage"
[ "$DRY_RUN" = 1 ] || git -C "$ROOT" fetch origin --quiet
wt="$(prepare_worktree "$branch" main)"
prompt="Integrate stage $stage. Merge these branches in this order: $*.
Follow your integrator instructions and write docs/reports/integration-$stage.md. Do not push; the pipeline pushes."
# INTEGRATE_NOTES: owner-requested cross-phase work (e.g. app wiring no phase owns).
[ -z "${INTEGRATE_NOTES:-}" ] || prompt="$prompt

## Owner-requested integration work (do this after merging; list it in the report)
$INTEGRATE_NOTES"
out="$(run_claude "$wt" integrator "$prompt" "stage-$stage-integrate")"
push_and_cleanup "$wt" "$branch"
if [ "$DRY_RUN" != 1 ] && command -v gh >/dev/null; then
  body="$(jq -r '.result // ""' "$out" | head -c 60000)"
  gh pr create --base main --head "$branch" --title "Stage $stage: $*" \
    --body "$body"$'\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)' >&2 \
    || log "PR not created (it may already exist); push succeeded"
else
  log "gh not found or dry run: open a PR from $branch to main yourself"
fi
log "stage $stage ready for your review. Merge the PR to main before starting the next stage."

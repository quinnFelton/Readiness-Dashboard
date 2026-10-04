#!/usr/bin/env bash
# Shared helpers for the build pipeline. Sourced by the other scripts.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
PIPE="$ROOT/pipeline"
LOGS="$PIPE/logs"
WT_ROOT="${WT_ROOT:-$(dirname "$ROOT")/$(basename "$ROOT")-worktrees}"
PERMISSION_MODE="${PERMISSION_MODE:-acceptEdits}"   # or: auto
DRY_RUN="${DRY_RUN:-0}"
# Local dev DB for agents' `pnpm db:migrate` / DB tests (an env-prefixed command wouldn't match the `pnpm *` allow rule).
export DATABASE_URL="${DATABASE_URL:-$(grep -E '^DATABASE_URL=' "$ROOT/.env.example" | cut -d= -f2-)}"
mkdir -p "$LOGS"

log()  { printf '\033[1;34m[pipeline %s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die()  { printf '\033[1;31m[pipeline] %s\033[0m\n' "$*" >&2; exit 1; }

require_tools() {
  for t in git jq claude; do command -v "$t" >/dev/null || die "missing required tool: $t"; done
}

# phase_meta <id> -> prints "agent branch base"
phase_meta() {
  local line
  line="$(awk -F'\t' -v id="$1" '$1==id {print $2" "$3" "$4}' "$PIPE/manifest.tsv")"
  [ -n "$line" ] || die "unknown phase id '$1' (see pipeline/manifest.tsv)"
  echo "$line"
}

worktree_path() { echo "$WT_ROOT/${1//\//-}"; }

# prepare_worktree <branch> <base> -> prints worktree path, ready on <branch>
prepare_worktree() {
  local branch="$1" base="$2" wt
  wt="$(worktree_path "$branch")"
  if [ "$DRY_RUN" = 1 ]; then echo "$wt"; return; fi
  if [ -d "$wt" ]; then log "reusing worktree $wt"; echo "$wt"; return; fi
  mkdir -p "$WT_ROOT"
  if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$ROOT" worktree add "$wt" "$branch" >&2
  elif git -C "$ROOT" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    git -C "$ROOT" worktree add --track -b "$branch" "$wt" "origin/$branch" >&2
  else
    local start="origin/$base"
    git -C "$ROOT" show-ref --verify --quiet "refs/remotes/$start" || start="$base"
    git -C "$ROOT" worktree add -b "$branch" "$wt" "$start" >&2
  fi
  # Fresh worktrees have no node_modules; agents can't always install them (permission prompts are off).
  (cd "$wt" && pnpm install --frozen-lockfile --prefer-offline >&2) || log "WARNING: pnpm install failed in $wt"
  echo "$wt"
}

# push_and_cleanup <worktree> <branch>
push_and_cleanup() {
  local wt="$1" branch="$2"
  [ "$DRY_RUN" = 1 ] && { log "(dry run) would push $branch"; return; }
  if [ -n "$(git -C "$wt" status --porcelain)" ]; then
    log "WARNING: $branch has uncommitted changes; leaving worktree at $wt for you to inspect"
  fi
  if git -C "$wt" rev-parse --verify --quiet "origin/$branch" >/dev/null &&
     [ "$(git -C "$wt" rev-parse HEAD)" = "$(git -C "$wt" rev-parse "origin/$branch")" ]; then
    log "$branch: nothing new to push"
  else
    git -C "$wt" push -u origin "$branch" >&2
    log "pushed $branch"
  fi
  if [ -z "$(git -C "$wt" status --porcelain)" ] && [ "${KEEP_WORKTREES:-0}" != 1 ]; then
    git -C "$ROOT" worktree remove "$wt" >&2 || true
  fi
}

# run_claude <worktree> <agent> <prompt> <label> [extra claude args...]
# Writes JSON output to pipeline/logs and prints the log path.
run_claude() {
  local wt="$1" agent="$2" prompt="$3" label="$4"; shift 4
  local out="$LOGS/$(date +%Y%m%d-%H%M%S)-${label//\//-}.json"
  if [ "$DRY_RUN" = 1 ]; then
    log "(dry run) in $wt: claude -p --agent $agent --permission-mode $PERMISSION_MODE $*"
    echo '{"result":"dry run","structured_output":{"passed":true,"summary":"dry run"},"total_cost_usd":0}' > "$out"
    echo "$out"; return 0
  fi
  log "$label: running agent '$agent' in $wt"
  set +e
  (cd "$wt" && claude -p "$prompt" \
      --agent "$agent" \
      --permission-mode "$PERMISSION_MODE" \
      --permission-prompts none \
      --output-format json "$@") > "$out"
  local rc=$?
  set -e
  local cost; cost="$(jq -r '.total_cost_usd // "?"' "$out" 2>/dev/null || echo '?')"
  log "$label: exit $rc, est. cost \$$cost, log $out"
  [ $rc -eq 0 ] || { log "$label FAILED; see $out"; return $rc; }
  echo "$out"
}

phase_prompt() {
  local id="$1" extra="${2:-}"
  local f="$PIPE/phases/$id.md"
  [ -f "$f" ] || die "missing phase prompt $f"
  cat "$f"
  printf '\n\n## Pipeline context\nYou are on branch `%s` in your own git worktree. Do not switch branches or push; commit as you go and the pipeline pushes for you. Only edit the paths docs/OWNERSHIP.md gives phase %s.\n' "$(phase_meta "$id" | cut -d' ' -f2)" "$id"
  [ -z "$extra" ] || printf '\n## Additional instructions for this run\n%s\n' "$extra"
}

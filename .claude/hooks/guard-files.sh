#!/usr/bin/env bash
# PreToolUse guard for Edit/Write: protect the spec, real env files, and applied migrations.
path="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input.file_path||"")}catch{}})')"
block() { echo "Blocked by .claude/hooks/guard-files.sh: $1" >&2; exit 2; }
rel="${path#"$CLAUDE_PROJECT_DIR"/}"

case "$rel" in
  PLAN.md) block "PLAN.md is the spec; propose spec changes in your final report instead." ;;
  .env|.env.local|.env.production) block "don't write real .env files; update .env.example." ;;
  .claude/settings.json|.claude/hooks/*) block "pipeline guardrails are human-maintained." ;;
esac

# A migration that already exists on origin/main has been applied somewhere; add a new one instead.
if [[ "$rel" == apps/api/db/migrations/* ]] && git -C "$CLAUDE_PROJECT_DIR" cat-file -e "origin/main:$rel" 2>/dev/null; then
  block "$rel is already on main; write a new migration rather than editing it."
fi
exit 0

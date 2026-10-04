#!/usr/bin/env bash
# PreToolUse guard for Bash. Exit 2 blocks the command and shows the reason to Claude.
# Backstop for the deny rules in settings.json, which can miss flag orderings.
cmd="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input.command||"")}catch{}})')"
block() { echo "Blocked by .claude/hooks/guard-bash.sh: $1" >&2; exit 2; }

[[ "$cmd" =~ git[[:space:]]+push.*(--force|[[:space:]]-f([[:space:]]|$)|--force-with-lease) ]] && block "force pushes are not allowed."
[[ "$cmd" =~ git[[:space:]]+push.*[[:space:]:](main|master)([[:space:]]|$) ]] && block "never push to main; push your phase branch and let the PR merge it."
[[ "$cmd" =~ --no-verify ]] && block "don't skip git hooks."
[[ "$cmd" =~ (cat|less|head|tail|grep|source|printenv)[^|]*\.env([[:space:]]|$|\.local|\.prod) ]] && block "don't read real .env files; use .env.example."
[[ "$cmd" =~ ^[[:space:]]*env[[:space:]]*$|^[[:space:]]*printenv[[:space:]]*$ ]] && block "don't dump the environment (it may contain secrets)."
[[ "$cmd" =~ cdk[[:space:]]+(deploy|destroy) ]] && block "deployment is a manual step (see infra/cdk/DEPLOY.md)."
[[ "$cmd" =~ rm[[:space:]]+-[a-zA-Z]*r[a-zA-Z]*f?[[:space:]]+(/|~|\$HOME|\.\.)([[:space:]]|/|$) ]] && block "refusing a recursive delete outside the repo."
exit 0

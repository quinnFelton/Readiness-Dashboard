#!/usr/bin/env bash
# PostToolUse: format the file Claude just wrote, if Prettier is installed. Never blocks.
path="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input.file_path||"")}catch{}})')"
prettier="$CLAUDE_PROJECT_DIR/node_modules/.bin/prettier"
case "$path" in
  *.ts|*.tsx|*.js|*.mjs|*.json|*.css|*.md|*.yml|*.yaml)
    [ -x "$prettier" ] && [ -f "$path" ] && "$prettier" --write --log-level silent "$path" >/dev/null 2>&1 ;;
esac
exit 0

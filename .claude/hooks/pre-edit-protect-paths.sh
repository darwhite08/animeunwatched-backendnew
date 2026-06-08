#!/usr/bin/env bash
set -euo pipefail

# PreToolUse hook. Receives the tool-call event as JSON on stdin.
# Exit 2 = block the tool call (works even in bypass mode); stderr is shown to Claude.

input="$(cat)"

# Edit/Write/MultiEdit put the target path in file_path; some tools use path.
file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.path // ""')"
[ -z "$file" ] && exit 0

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
rel="${file#"$repo_root"/}"   # make repo-relative if absolute

locklist="$repo_root/.claude/locked-paths.txt"
[ -f "$locklist" ] || exit 0

while IFS= read -r pattern; do
  [ -z "$pattern" ] && continue
  case "$pattern" in \#*) continue ;; esac
  # In `case`, * matches across '/', so app/src/foo/** matches nested files.
  case "$rel" in
    $pattern)
      echo "BLOCKED: '$rel' is a LOCKED file (matches '$pattern' in .claude/locked-paths.txt)." 1>&2
      echo "Do not edit locked features. If this change is genuinely required, stop and ask the user to unlock it in .claude/LOCKED.md first." 1>&2
      exit 2
      ;;
  esac
done < "$locklist"

exit 0

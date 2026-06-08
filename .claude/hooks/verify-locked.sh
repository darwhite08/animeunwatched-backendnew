#!/usr/bin/env bash
set -euo pipefail

# Stop hook. Runs when Claude tries to finish its turn.
# Exit 2 = don't let it stop; stderr tells it what to fix.

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"

# Must exit non-zero on failure. --passWithNoTests so an empty tests/locked
# (nothing locked yet) is a pass rather than a vitest error.
TEST_CMD="${LOCKED_TEST_CMD:-npm run --silent test:locked}"

if ! output="$($TEST_CMD 2>&1)"; then
  echo "LOCKED TESTS FAILED — a locked feature's behavior changed." 1>&2
  printf '%s\n' "$output" | tail -n 40 1>&2
  echo "Revert the change that broke the locked test, or fix the code so the locked test passes again." 1>&2
  echo "DO NOT modify or delete the locked test to make it pass." 1>&2
  exit 2
fi

exit 0

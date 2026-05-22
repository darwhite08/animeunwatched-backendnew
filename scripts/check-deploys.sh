#!/usr/bin/env bash
#
# check-deploys.sh — verify the latest local commits are actually live on
# Render (backend) and Vercel (frontend).
#
# Compares for each surface:
#   local HEAD  vs  origin/<deploy-branch>  vs  deployed SHA (/version endpoint)
#
# States per surface:
#   ✅ live          — local HEAD == origin == deployed
#   ⏳ deploying     — local HEAD == origin but deployed is older (Render/Vercel still building)
#   📝 unpushed      — local HEAD != origin (you have local commits not pushed yet)
#   ❌ drift         — origin != deployed AND it's not still building (manual investigation)
#   ⚠️  unreachable  — could not fetch /version
#
# Exit code: 0 if everything is ✅ live, else 1.

set -uo pipefail

# Live in animeunwatched-backend/scripts/. Resolve sibling frontend repo
# via the parent of the backend repo root.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$BACKEND_DIR/.." && pwd)"

BACKEND_BRANCH="main"
BACKEND_URL="https://kaiveron-backend.onrender.com/api/v1/version"

FRONTEND_DIR="$PROJECT_ROOT/animeunwatched-frontend"
FRONTEND_BRANCH="production"
FRONTEND_URL="https://animeunwatched-frontend-delta.vercel.app/api/version"

# --- helpers ---------------------------------------------------------------

short() { printf '%.7s' "$1"; }

fetch_sha() {
  local url="$1"
  local body
  body=$(curl -fsS --max-time 10 "$url" 2>/dev/null) || { echo ""; return; }
  printf '%s' "$body" | sed -nE 's/.*"sha"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p'
}

check_surface() {
  local label="$1" dir="$2" branch="$3" url="$4"
  if [ ! -d "$dir/.git" ]; then
    printf '⚠️  %-9s no git repo at %s\n' "$label" "$dir"
    return 2
  fi
  git -C "$dir" fetch --quiet origin "$branch" 2>/dev/null || true
  local local_sha origin_sha deployed_sha
  local_sha=$(git -C "$dir" rev-parse HEAD 2>/dev/null) || local_sha=""
  origin_sha=$(git -C "$dir" rev-parse "origin/$branch" 2>/dev/null) || origin_sha=""
  deployed_sha=$(fetch_sha "$url")

  printf '\n── %s ─────────────────────────────────────\n' "$label"
  printf '  local HEAD       : %s\n' "$(short "${local_sha:-?}")"
  printf '  origin/%-10s: %s\n' "$branch" "$(short "${origin_sha:-?}")"
  printf '  deployed (%s)\n               %s : %s\n' "${url##*//}" "" "$(short "${deployed_sha:-?}")"

  if [ -z "$deployed_sha" ]; then
    printf '  ⚠️  unreachable — could not read deployed SHA\n'
    return 2
  fi
  if [ "$deployed_sha" = "dev" ]; then
    printf '  ⚠️  deployed reports sha=dev — env var not injected on platform\n'
    return 2
  fi
  if [ "$local_sha" != "$origin_sha" ]; then
    printf '  📝 unpushed — local HEAD has commits not on origin/%s\n' "$branch"
    return 1
  fi
  if [ "$origin_sha" = "$deployed_sha" ]; then
    printf '  ✅ live\n'
    return 0
  fi
  # origin is ahead of deployed → most likely deploy still in flight
  if git -C "$dir" merge-base --is-ancestor "$deployed_sha" "$origin_sha" 2>/dev/null; then
    printf '  ⏳ deploying — origin is %s commits ahead of deployed\n' \
      "$(git -C "$dir" rev-list --count "$deployed_sha..$origin_sha" 2>/dev/null)"
    return 1
  fi
  printf '  ❌ drift — deployed SHA is not an ancestor of origin/%s\n' "$branch"
  return 1
}

# --- run -------------------------------------------------------------------

overall=0
check_surface "Backend"  "$BACKEND_DIR"  "$BACKEND_BRANCH"  "$BACKEND_URL"  || overall=1
check_surface "Frontend" "$FRONTEND_DIR" "$FRONTEND_BRANCH" "$FRONTEND_URL" || overall=1

echo
if [ "$overall" -eq 0 ]; then
  echo "✅ All surfaces are live on their latest pushed commit."
else
  echo "⚠️  See above — at least one surface is not on the latest commit."
fi
exit "$overall"

#!/usr/bin/env bash
set -euo pipefail

# swap.sh — single-command catalog provider swap.
# See docs/mock.md for full procedure.

PROVIDER="${1:-}"
if [[ -z "$PROVIDER" ]]; then
  echo "Usage: ./scripts/swap.sh <jikan|mal|anilist>"
  exit 1
fi

case "$PROVIDER" in
  jikan|mal|anilist) ;;
  *) echo "Unknown provider: $PROVIDER"; exit 1 ;;
esac

PROVIDER_FILE="src/lib/catalog/${PROVIDER}.provider.ts"
if [[ ! -f "$PROVIDER_FILE" ]]; then
  echo "Provider implementation missing: $PROVIDER_FILE"
  echo "Create it (implement CatalogProvider) before running swap."
  exit 2
fi

ENV_FILE=".env"
if [[ "${NODE_ENV:-development}" == "production" && -f ".env.production" ]]; then
  ENV_FILE=".env.production"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file not found: $ENV_FILE"
  exit 3
fi

if grep -q "^CATALOG_PROVIDER=" "$ENV_FILE"; then
  sed -i.bak "s/^CATALOG_PROVIDER=.*/CATALOG_PROVIDER=${PROVIDER}/" "$ENV_FILE"
else
  echo "CATALOG_PROVIDER=${PROVIDER}" >> "$ENV_FILE"
fi
rm -f "${ENV_FILE}.bak"

echo "Updated $ENV_FILE: CATALOG_PROVIDER=${PROVIDER}"

echo "Validating provider…"
npx tsx scripts/validateProvider.ts "$PROVIDER"

echo
echo "Swap complete. Restart the API for the change to take effect:"
echo "  docker compose restart api    # docker"
echo "  # or kill the dev process and re-run: npm run dev"

#!/usr/bin/env bash
# Delete the price data for the date 6 days ago (rolling 5-day retention).
# Run after load-prices. No dump — we don't need the old data back.
set -euo pipefail

# Retention: keep the last RETAIN_DAYS days; delete the day just beyond that.
RETAIN_DAYS="${RETAIN_DAYS:-6}"

# Compute YYYY-MM-DD for RETAIN_DAYS ago, handling both GNU and BSD date.
if date -d '1 day ago' >/dev/null 2>&1; then
  TARGET="$(date -d "${RETAIN_DAYS} days ago" +%F)"   # GNU/Linux
else
  TARGET="$(date -v-"${RETAIN_DAYS}"d +%F)"           # macOS/BSD
fi

# Resolve bun even when PATH is minimal (e.g. under cron).
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"

cd "$(dirname "$0")"
exec "$BUN" run delete-date -- --date "$TARGET" --no-dump

#!/usr/bin/env bash
#
# Safe restart helper - finds current PID and calls restart-with-rollback.sh
#
# Usage: Just run this script, it will find the running mirror process
#
# This script DETACHES IMMEDIATELY to survive parent death
#

set -euo pipefail

PROJECT_DIR="/Users/utensil/projects/opencode-telegram-mirror"

# Find current mirror process
CURRENT_PID=$(ps aux | grep "bun run src/main.ts" | grep -v grep | awk '{print $2}' | head -1)

if [ -z "$CURRENT_PID" ]; then
    echo "❌ No running mirror process found"
    echo "Starting fresh instance..."
    cd "$PROJECT_DIR"
    bun run src/main.ts . &
    exit 0
fi

echo "Found running mirror process: PID $CURRENT_PID"
echo "Calling restart-with-rollback.sh (will detach)..."
echo ""

# Call the restart-with-rollback script
# It will self-detach immediately
cd "$PROJECT_DIR"
exec .agents/scripts/restart-with-rollback.sh "$CURRENT_PID"

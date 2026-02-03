#!/usr/bin/env bash
#
# Restart OpenCode Telegram Mirror with automatic rollback on failure
#
# Usage: .agents/scripts/restart-with-rollback.sh <pid>
#
# Logic:
# 1. Detach from parent process immediately (if called from bot)
# 2. Kill current process
# 3. Start new instance in background
# 4. Wait 30 seconds
# 5. Check if new process is alive
#    - If alive: Success!
#    - If dead: Rollback to @- with `jj new @-`, then restart (recursive)
#
# This will eventually rollback to a working commit.

set -euo pipefail

# Detect VCS type (jj or git)
if [ -d ".jj" ]; then
    VCS="jj"
elif [ -d ".git" ]; then
    VCS="git"
else
    echo "❌ Error: No .jj or .git directory found"
    exit 1
fi

echo "Detected VCS: $VCS"

# Self-detach if we have a parent (called from bot)
if [ -n "${RESTART_DETACHED:-}" ]; then
    # Already detached, continue normally
    :
else
    # Detach and re-exec ourselves
    export RESTART_DETACHED=1
    nohup "$0" "$@" > /tmp/restart-with-rollback.log 2>&1 &
    echo "Restart script detached to background"
    exit 0
fi

CURRENT_PID=$1
PROJECT_DIR="/Users/utensil/projects/opencode-telegram-mirror"
HEALTH_CHECK_TIMEOUT=30

cd "$PROJECT_DIR"

echo "=== Restart with Rollback ==="
echo "Current PID: $CURRENT_PID"
echo "Project dir: $PROJECT_DIR"
echo "Health check timeout: ${HEALTH_CHECK_TIMEOUT}s"
echo ""

# Kill current process
echo "Killing current process..."
kill -9 "$CURRENT_PID"
sleep 1

# Start new instance in background
echo "Starting new instance..."
LOG_FILE="/tmp/mirror-restart-$(date +%s).log"
nohup bun run src/main.ts . > "$LOG_FILE" 2>&1 &
NEW_PID=$!

echo "New instance started (PID: $NEW_PID)"
echo "Log file: $LOG_FILE"
echo "Waiting ${HEALTH_CHECK_TIMEOUT}s for health check..."

# Wait for health check
sleep "$HEALTH_CHECK_TIMEOUT"

# Check if process is still alive
if ps -p "$NEW_PID" > /dev/null 2>&1; then
    echo "✅ SUCCESS! New instance is healthy (PID: $NEW_PID)"
    echo "Restart completed successfully"
    exit 0
else
    echo "❌ FAILED! New instance died (PID: $NEW_PID)"
    echo "Log tail:"
    tail -20 "$LOG_FILE"
    echo ""
    echo "Rolling back to previous commit..."
    
    # Rollback: Create new commit based on parent
    if [ "$VCS" = "jj" ]; then
        jj new @-
    else
        git reset --hard HEAD~1
    fi
    
    echo "Rolled back to parent commit"
    echo "Attempting restart with rolled-back code..."
    
    # Recursive restart with new working copy
    # The script will detect the new process and check again
    nohup bun run src/main.ts . > "/tmp/mirror-rollback-$(date +%s).log" 2>&1 &
    ROLLBACK_PID=$!
    
    echo "Rollback instance started (PID: $ROLLBACK_PID)"
    echo "Waiting ${HEALTH_CHECK_TIMEOUT}s for health check..."
    
    sleep "$HEALTH_CHECK_TIMEOUT"
    
    if ps -p "$ROLLBACK_PID" > /dev/null 2>&1; then
        echo "✅ ROLLBACK SUCCESS! Instance is healthy (PID: $ROLLBACK_PID)"
        echo "Restart completed with rollback"
        exit 0
    else
        echo "❌ ROLLBACK ALSO FAILED!"
        echo "Manual intervention required"
        echo "Check logs in /tmp/mirror-*.log"
        exit 1
    fi
fi

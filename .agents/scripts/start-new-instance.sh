#!/usr/bin/env bash
#
# Start a new OpenCode Telegram Mirror instance in a specified directory
#
# Usage: .agents/scripts/start-new-instance.sh <target-directory> [thread-id] [device-name]
#
# Defaults:
# - iCloud coordination: ENABLED (USE_ICLOUD_COORDINATOR=true)
# - Environment variables: INHERITED from current shell
# - Thread ID: INHERITED or specify as 2nd argument
# - Device name: INHERITED or specify as 3rd argument
#
# The script will:
# 1. Check for conflicts (same device, same directory)
# 2. Reject if conflict found
# 3. Start new instance in background with inherited/specified config
# 4. Verify it started successfully
#

set -euo pipefail

TARGET_DIR="${1:-}"
THREAD_ID="${2:-}"
DEVICE_NAME="${3:-}"

PROJECT_DIR="/Users/utensil/projects/opencode-telegram-mirror"

if [ -z "$TARGET_DIR" ]; then
    echo "❌ Error: Target directory required"
    echo ""
    echo "Usage: $0 <target-directory> [thread-id] [device-name]"
    echo ""
    echo "Examples:"
    echo "  $0 /path/to/project"
    echo "  $0 /path/to/project 123"
    echo "  $0 /path/to/project 123 laptop"
    echo ""
    echo "Environment variables:"
    echo "  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID: Required (inherited from current shell)"
    echo "  TELEGRAM_THREAD_ID: Optional (can specify as 2nd argument)"
    echo "  DEVICE_NAME: Optional (can specify as 3rd argument)"
    echo "  USE_ICLOUD_COORDINATOR: Default=true (always enabled)"
    exit 1
fi

# Resolve to absolute path
TARGET_DIR=$(cd "$TARGET_DIR" && pwd)

echo "=== Start New Mirror Instance ==="
echo "Target directory: $TARGET_DIR"
echo "Project directory: $PROJECT_DIR"
echo ""

# Check if target directory exists
if [ ! -d "$TARGET_DIR" ]; then
    echo "❌ Error: Target directory does not exist: $TARGET_DIR"
    exit 1
fi

# Check for conflicts using iCloud coordination
echo "Checking for conflicts..."
cd "$PROJECT_DIR"

CONFLICT_CHECK=$(bun run .agents/scripts/check-conflict.ts "$TARGET_DIR")
CONFLICT_EXIT=$?

if [ $CONFLICT_EXIT -eq 1 ]; then
    echo "❌ CONFLICT DETECTED!"
    echo ""
    echo "Another instance is already running on this directory:"
    echo "$CONFLICT_CHECK" | tail -n +2  # Skip "CONFLICT" line
    echo ""
    echo "Cannot start new instance."
    echo "If the conflicting instance is dead, wait 5 minutes for it to be considered stale."
    exit 1
fi

echo "✅ No conflicts found"
echo ""

# Load config from file (same as bot does)
CONFIG_HOME="${HOME}/.config/opencode"
CONFIG_FILE="$CONFIG_HOME/telegram.json"

if [ -f "$CONFIG_FILE" ]; then
    echo "Loading config from $CONFIG_FILE..."
    
    # Parse JSON using bun (quick and available)
    BOT_TOKEN=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf-8')).botToken || '')")
    CHAT_ID=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf-8')).chatId || '')")
    THREAD_ID=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf-8')).threadId || '')")
    
    if [ -n "$BOT_TOKEN" ]; then
        export TELEGRAM_BOT_TOKEN="$BOT_TOKEN"
    fi
    
    if [ -n "$CHAT_ID" ]; then
        export TELEGRAM_CHAT_ID="$CHAT_ID"
    fi
    
    if [ -n "$THREAD_ID" ] && [ "$THREAD_ID" != "null" ]; then
        export TELEGRAM_THREAD_ID="$THREAD_ID"
    fi
fi

# Override with arguments if provided
if [ -n "$THREAD_ID" ]; then
    export TELEGRAM_THREAD_ID="$THREAD_ID"
fi

if [ -n "$DEVICE_NAME" ]; then
    export DEVICE_NAME="$DEVICE_NAME"
fi

# Check required environment variables
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
    echo "❌ Error: TELEGRAM_BOT_TOKEN not set"
    echo "Set it in $CONFIG_FILE or export TELEGRAM_BOT_TOKEN"
    exit 1
fi

if [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    echo "❌ Error: TELEGRAM_CHAT_ID not set"
    echo "Set it in $CONFIG_FILE or export TELEGRAM_CHAT_ID"
    exit 1
fi

echo "Environment:"
echo "  BOT_TOKEN: ${TELEGRAM_BOT_TOKEN:0:10}... (set)"
echo "  CHAT_ID: $TELEGRAM_CHAT_ID"
echo "  THREAD_ID: ${TELEGRAM_THREAD_ID:-(inherited or none)}"
echo "  DEVICE_NAME: ${DEVICE_NAME:-(auto-generated)}"
echo "  USE_ICLOUD_COORDINATOR: true"
echo ""

# Start new instance
LOG_FILE="/tmp/mirror-new-$(date +%s).log"

echo "Starting new instance..."
echo "Log file: $LOG_FILE"

nohup bun run "$PROJECT_DIR/src/main.ts" "$TARGET_DIR" > "$LOG_FILE" 2>&1 &
NEW_PID=$!

echo "Instance started (PID: $NEW_PID)"
echo ""
echo "Waiting 5 seconds to verify startup..."
sleep 5

if ps -p "$NEW_PID" > /dev/null 2>&1; then
    echo "✅ SUCCESS! Instance is running (PID: $NEW_PID)"
    echo ""
    echo "Instance details:"
    echo "  PID: $NEW_PID"
    echo "  Directory: $TARGET_DIR"
    echo "  Log: $LOG_FILE"
    echo ""
    echo "Use '/dev' in Telegram to see all devices"
    echo "Use '/use <number>' to activate this device"
    exit 0
else
    echo "❌ FAILED! Instance died during startup"
    echo ""
    echo "Log tail:"
    tail -30 "$LOG_FILE"
    exit 1
fi

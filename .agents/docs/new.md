# Start New Instance Procedure

## Overview

This document describes how to start a new OpenCode Telegram Mirror instance in a specified directory with automatic conflict detection.

## 🎯 **Quick Usage**

**To start a new instance, say:**
```
"start a new instance in /path/to/project per new.md"
```

**AI will execute:**
```bash
.agents/scripts/start-new-instance.sh /path/to/project
```

## 🔧 **The Script**

### Primary Script: `.agents/scripts/start-new-instance.sh`

**Usage:**
```bash
.agents/scripts/start-new-instance.sh <target-directory> [thread-id] [device-name]
```

**Arguments:**
1. **target-directory** (required): Directory to work on
2. **thread-id** (optional): Telegram thread ID for this instance
3. **device-name** (optional): Custom device name prefix

**Examples:**
```bash
# Basic (inherits env vars, auto thread ID, auto device name)
.agents/scripts/start-new-instance.sh /Users/me/project-a

# With thread ID
.agents/scripts/start-new-instance.sh /Users/me/project-a 123

# With thread ID and device name
.agents/scripts/start-new-instance.sh /Users/me/project-a 123 laptop
```

## 🎯 **Default Behavior**

### ✅ Defaults Applied

1. **iCloud Coordination:** ALWAYS ENABLED
   - `USE_ICLOUD_COORDINATOR=true` (automatic)
   - Device automatically registers in iCloud Drive
   - Participates in multi-device coordination

2. **Environment Variables:** INHERITED
   - `TELEGRAM_BOT_TOKEN` - Inherited from current shell
   - `TELEGRAM_CHAT_ID` - Inherited from current shell
   - `TELEGRAM_THREAD_ID` - Inherited unless specified as argument

3. **Thread ID:** INHERITED OR NONE
   - If current shell has `TELEGRAM_THREAD_ID` → uses it
   - If specified as argument → uses argument
   - If neither → uses main chat (no thread)

4. **Device Name:** AUTO-GENERATED
   - Default: `hostname:directory`
   - If argument provided: `customName@hostname:directory`
   - If current shell has `DEVICE_NAME` → uses it as prefix

### ⚠️ Required Environment Variables

Must be set in your shell before running:
- `TELEGRAM_BOT_TOKEN` - Bot token
- `TELEGRAM_CHAT_ID` - Chat ID

**If not set:**
```bash
export TELEGRAM_BOT_TOKEN="your-token"
export TELEGRAM_CHAT_ID="your-chat-id"
```

Or configure in `~/.config/opencode/telegram.json`

## 🚫 **Conflict Detection**

### How It Works

**Uses iCloud coordination device registry** to detect conflicts:

1. Reads all device files from `~/Library/Mobile Documents/com~apple~CloudDocs/opencode-telegram-mirror/devices/`
2. Checks if any device on **same hostname** is working on **same directory**
3. Verifies device is alive:
   - `lastSeen` within 5 minutes
   - Process (PID) still running
4. If conflict found → **REJECT** startup

### Conflict Example

```bash
# Instance already running on /project-a
$ .agents/scripts/start-new-instance.sh /project-a

❌ CONFLICT DETECTED!

Another instance is already running on this directory:
{
  "name": "MacBook-Pro.local:/project-a",
  "threadId": 123,
  "lastSeen": 1234567890,
  "hostname": "MacBook-Pro.local",
  "directory": "/project-a",
  "pid": 12345
}

Cannot start new instance.
If the conflicting instance is dead, wait 5 minutes for it to be considered stale.
```

### No Conflict Cases

✅ **Different directory on same device:**
```bash
# These can both run
Instance 1: /project-a
Instance 2: /project-b
```

✅ **Same directory on different device:**
```bash
# These can both run (different hostnames)
MacBook: /shared-project
iMac: /shared-project
```

✅ **Stale device (> 5 minutes):**
```bash
# Old instance crashed, new one can start
Old instance: lastSeen 6 minutes ago (stale)
New instance: Starts successfully
```

## 📝 **Invocation Patterns**

When you say these phrases, AI should execute the script:

**Basic:**
- "start a new instance in /path/to/project per new.md"
- "start new mirror in /path per new.md"

**With thread ID:**
- "start a new instance in /path with thread 123 per new.md"
- "start new mirror in /path thread 456 per new.md"

**With device name:**
- "start a new instance in /path as laptop per new.md"

**Command format:**
```bash
# Parse from natural language:
# - Extract directory path
# - Extract thread ID if mentioned
# - Extract device name if mentioned

.agents/scripts/start-new-instance.sh <directory> [thread-id] [device-name]
```

## 🎮 **Usage Scenarios**

### Scenario 1: Start Second Instance on Same Device

```bash
# Current instance running on /project-a
# Start new instance on /project-b

You: "start a new instance in /Users/me/project-b per new.md"
AI: Executes .agents/scripts/start-new-instance.sh /Users/me/project-b

Result:
- No conflict (different directories)
- New instance starts successfully
- Both run in standby initially
- Use /dev to see both, /use to activate one
```

### Scenario 2: Attempt to Start Duplicate (Rejected)

```bash
# Instance already running on /project-a
# Try to start another on same directory

You: "start a new instance in /Users/me/project-a per new.md"
AI: Executes .agents/scripts/start-new-instance.sh /Users/me/project-a

Result:
- ❌ Conflict detected
- Script exits with error
- Shows conflicting device info
- No new instance started
```

### Scenario 3: Start with Custom Thread

```bash
You: "start a new instance in /project-c with thread 789 per new.md"
AI: Executes .agents/scripts/start-new-instance.sh /project-c 789

Result:
- New instance monitors thread 789
- Inherits bot token and chat ID
- iCloud coordination enabled
- Device registered automatically
```

### Scenario 4: Start with Custom Device Name

```bash
You: "start a new instance in /client-work as work-laptop per new.md"
AI: Executes .agents/scripts/start-new-instance.sh /client-work "" work-laptop

Result:
- Device ID: work-laptop@MacBook-Pro.local:/client-work
- Easier to identify in /dev output
- Thread ID inherited from environment
```

## 🔍 **Conflict Detection Details**

### Helper Script: `.agents/scripts/check-conflict.ts`

**What it checks:**
```typescript
For each device in iCloud registry:
  if (device.hostname === currentHostname 
      AND device.directory === targetDirectory) {
    if (device.lastSeen within 5 minutes) {
      if (process PID still running) {
        → CONFLICT!
      }
    }
  }
```

**Why this works:**
- Uses iCloud coordination (our source of truth)
- Checks same device (hostname) only
- Verifies process is actually alive (not just stale registry)
- 5 minute stale threshold (10x heartbeat interval)

### Why 5 Minutes?

- Standby devices write heartbeat every 5-6 minutes
- If no heartbeat for 5 minutes → likely dead
- Safe threshold: won't reject legitimately running standbys

## 📊 **What Gets Inherited**

| Variable | Source | Fallback |
|----------|--------|----------|
| `TELEGRAM_BOT_TOKEN` | Current shell | ❌ Required |
| `TELEGRAM_CHAT_ID` | Current shell | ❌ Required |
| `TELEGRAM_THREAD_ID` | Argument > Shell > None | Main chat |
| `DEVICE_NAME` | Argument > Shell > Auto | `hostname:dir` |
| `USE_ICLOUD_COORDINATOR` | Always `true` | N/A |

## 🎯 **Multi-Instance Setup Example**

```bash
# Setup environment once
export TELEGRAM_BOT_TOKEN="your-token"
export TELEGRAM_CHAT_ID="your-chat-id"

# Start instance 1 - Project A
.agents/scripts/start-new-instance.sh /Users/me/project-a 123 laptop
# Device: laptop@MacBook-Pro:/Users/me/project-a
# Thread: 123

# Start instance 2 - Project B
.agents/scripts/start-new-instance.sh /Users/me/project-b 456 desktop
# Device: desktop@MacBook-Pro:/Users/me/project-b
# Thread: 456

# In Telegram
/dev
# Shows:
# ⚪ Standby [1] laptop@MacBook-Pro:/Users/me/project-a
# ⚪ Standby [2] desktop@MacBook-Pro:/Users/me/project-b

/use 1
# Activates instance 1 (project-a)
```

## 🧪 **Testing**

### Test 1: Start New Instance

```bash
.agents/scripts/start-new-instance.sh /tmp/test-project

# Should succeed:
# - Creates device in iCloud
# - Starts instance
# - Shows in /dev
```

### Test 2: Detect Conflict

```bash
# Start first instance
.agents/scripts/start-new-instance.sh /tmp/test-project

# Try to start second on same directory
.agents/scripts/start-new-instance.sh /tmp/test-project

# Should fail with conflict error
```

### Test 3: With Thread ID

```bash
.agents/scripts/start-new-instance.sh /tmp/test-project 999

# Should start with thread 999
```

### Test 4: Stale Device Cleanup

```bash
# Start instance
.agents/scripts/start-new-instance.sh /tmp/test

# Kill it
kill -9 <pid>

# Wait 6 minutes

# Try again
.agents/scripts/start-new-instance.sh /tmp/test

# Should succeed (old device considered stale)
```

## ⚠️ **Limitations**

### Cross-Device Conflicts Not Detected

The script only checks for conflicts on the **same hostname**:

```bash
# These can both start (different devices)
MacBook: /shared/project
iMac: /shared/project

# Both will work, but might conflict if working on same files
# This is by design - allows failover between devices
```

**Why:** We WANT to allow same directory on different devices for failover scenarios.

### Race Condition Window

Between conflict check and instance start (~1 second):
- Another process might start
- Both might pass conflict check
- Rare, but possible

**Mitigation:** iCloud coordination will handle it (both register, one becomes active)

## 🎉 **Summary**

**When you say:** "start a new instance in /path/to/project per new.md"

**AI executes:** `.agents/scripts/start-new-instance.sh /path/to/project`

**What happens:**
1. ✅ Checks for conflicts (same device, same directory)
2. ✅ Rejects if conflict found (process alive within 5 minutes)
3. ✅ Inherits environment (bot token, chat ID)
4. ✅ Enables iCloud coordination (automatic)
5. ✅ Starts instance in background
6. ✅ Verifies startup (5 second health check)
7. ✅ Reports success with PID and log location

**Simple, safe, conflict-aware!**

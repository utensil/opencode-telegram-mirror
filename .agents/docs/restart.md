# Safe Restart Procedure

## Overview

This document describes how to safely restart the **active bot instance** with automatic rollback on failure.

## ⚠️ Critical Requirement: Detached Execution

**NEVER execute restart commands directly from the bot context!**

When the bot executes a command, that command runs as a **child process**. If you kill the bot, all child processes die too, including the restart command.

**Solution:** The restart script **self-detaches** immediately before doing anything dangerous.

## 🔧 **Restart Scripts**

### Primary Script: `.agents/scripts/safe-restart.sh`

**Usage:**
```bash
.agents/scripts/safe-restart.sh
```

**What it does:**
1. Finds the active bot PID automatically
2. Calls `restart-with-rollback.sh` with that PID
3. Exits immediately (script continues detached)

### Core Script: `.agents/scripts/restart-with-rollback.sh`

**Usage:**
```bash
.agents/scripts/restart-with-rollback.sh <pid>
```

**Logic:**
1. **Self-detach** using `nohup` and re-execution (safe from parent death)
2. Kill the specified PID
3. Start new instance: `bun run src/main.ts .`
4. Wait **30 seconds**
5. Check if new process is alive:
   - ✅ **Alive**: Success! Exit.
   - ❌ **Dead**: Rollback and retry:
     - Run `jj new @-` (create new working copy from parent commit)
     - Start new instance with rolled-back code
     - Wait 30 seconds and check again
     - If still dead: Manual intervention required

**Key insight:** The script will recursively rollback until it finds a working commit.

## 📝 **When to Use**

### Scenario 1: Testing New Code

You've made changes and want to restart the active bot:
```
You: "restart safely per restart.md"
AI: Executes .agents/scripts/safe-restart.sh
```

If new code has bugs → automatic rollback to previous working commit.

### Scenario 2: Active Bot is Unresponsive

Active bot stopped responding but process is still alive:
```bash
# Manual execution in terminal
.agents/scripts/safe-restart.sh
```

### Scenario 3: After Commits

You've committed new features and want to deploy:
```
You: "restart safely per restart.md"
```

## 🎯 **Invocation Patterns**

When you say these phrases, AI should execute the restart script:

- "restart safely"
- "restart safely per restart.md"
- "safe restart"
- "restart with rollback"

**Command to execute:**
```bash
.agents/scripts/safe-restart.sh
```

## ⚠️ **What NOT To Do**

**DON'T:**
```bash
# Direct kill + restart (no detach, no rollback)
kill -9 <pid> && bun run src/main.ts .  ❌

# Kill without waiting for detach
bash restart-script.sh & kill -9 <pid>  ❌

# No rollback on failure
kill -9 <pid>; bun run src/main.ts .    ❌
```

**DO:**
```bash
# Use the safe restart script
.agents/scripts/safe-restart.sh  ✅
```

## 🧪 **Testing the Rollback**

To test that rollback works:

1. **Introduce a bug** (e.g., syntax error in main.ts)
2. **Commit the bug**
3. **Run safe restart**
4. **Observe:**
   - New instance starts but crashes immediately
   - After 30s, script detects failure
   - Script runs `jj new @-` (rollback)
   - Script starts instance with previous code
   - Bot works again!

## 📊 **Health Check Details**

**Health check criterion:** Process is alive after 30 seconds

**Why 30 seconds?**
- Enough time for bot to:
  - Initialize coordinator
  - Connect to Telegram
  - Start polling loop
  - Crash if there are obvious bugs
- Not too long (fast feedback)
- Matches half of heartbeat interval

**What we DON'T check:**
- Whether bot successfully polled Telegram (too complex)
- Whether bot sent messages (requires Telegram API state)
- Whether OpenCode server started (might be optional)

**Simple is better:** If process survives 30s, it's probably working.

## 🔄 **Rollback Strategy**

**Command:** `jj new @-`

**What it does:**
- Creates a new working copy based on parent commit (@-)
- Does NOT modify the failed commit (keeps history)
- Working copy now at previous code state
- Next restart uses the rolled-back code

**Example:**
```
Before restart:
@  (current) feat: new feature [AGENT]  ← Has bug
○  (parent) docs: documentation [AGENT]  ← Last known good

After rollback (jj new @-):
@  (new WC) (empty)                     ← New working copy
│  Based on parent (rolled back)
○  feat: new feature [AGENT]            ← Failed commit (kept)
○  docs: documentation [AGENT]          ← Code state restored
```

**Why `jj new` not `jj edit`:**
- `jj edit @-` would edit the parent commit directly
- `jj new @-` creates a clean working copy for new work
- Keeps failed commits in history for debugging

## 🎯 **Recursive Rollback**

If multiple commits are broken:

```
Attempt 1: Restart with commit C (broken) → Dead after 30s
           ↓
Rollback:  jj new @-  (go to commit B)
           ↓
Attempt 2: Restart with commit B (broken) → Dead after 30s
           ↓
Rollback:  jj new @-  (go to commit A)
           ↓
Attempt 3: Restart with commit A (working) → Alive! ✅
```

**Eventually reaches a working commit!**

## 📁 **Log Files**

Restart logs are saved to:
- `/tmp/restart-with-rollback.log` - Script execution log
- `/tmp/mirror-restart-<timestamp>.log` - Bot startup log (success)
- `/tmp/mirror-rollback-<timestamp>.log` - Bot startup log (rollback attempt)

Check these files to debug failed restarts.

## 🔐 **Safety Guarantees**

1. ✅ **Script survives bot death** (self-detaching)
2. ✅ **Automatic rollback** (no manual intervention)
3. ✅ **Eventually succeeds** (recursive rollback)
4. ✅ **Preserves history** (uses `jj new` not `jj edit`)
5. ✅ **Logs everything** (full debugging info)

## 🎉 **Summary**

**When you say:** "restart safely per restart.md"

**AI executes:** `.agents/scripts/safe-restart.sh`

**What happens:**
1. Script detaches immediately (safe)
2. Finds and kills current bot
3. Starts new instance
4. Waits 30s and checks health
5. Rolls back if failed
6. Repeats until success

**Simple, safe, automatic!**

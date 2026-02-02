# Device Management Commands - Short & Simple

## 📱 **Commands**

| Command | Description | Example |
|---------|-------------|---------|
| `/dev` | List all devices (numbered) | `/dev` |
| `/use <number>` | Activate device by number | `/use 2` |
| `/use <name>` | Activate device by full name | `/use laptop@Mac:/project` |

## 🎮 **Usage Example**

```
You: /dev

Bot:
*Registered Devices:*

🟢 ACTIVE [1] `laptop@MacBook-Pro:/Users/me/project-a`
  Thread: 123
  Last seen: 2s ago
  Heartbeat: 1s ago ✅

⚪ Standby [2] `desktop@iMac:/Users/me/project-b`
  Thread: 456
  Last seen: 45s ago

⚪ Standby [3] `work@MacBook-Pro:/Users/me/client-x`
  Thread: 789
  Last seen: 3m 12s ago

_Use /use <number> to activate a device_
_Heartbeat timeout: 90s_

You: /use 2

Bot: ✅ Device #2 "desktop@iMac:/Users/me/project-b" is now ACTIVE

You: /dev

Bot:
*Registered Devices:*

🟢 ACTIVE [1] `desktop@iMac:/Users/me/project-b`
  Thread: 456
  Last seen: 1s ago
  Heartbeat: 1s ago ✅

⚪ Standby [2] `laptop@MacBook-Pro:/Users/me/project-a`
  Thread: 123
  Last seen: 2s ago

⚪ Standby [3] `work@MacBook-Pro:/Users/me/client-x`
  Thread: 789
  Last seen: 3m 12s ago
```

**Note:** Active device is always #1, sorted by most recently seen

## 🔧 **Code to Add to main.ts**

### Location
In `handleTelegramMessage()` after `/version` command (around line 782)

### Complete Code

```typescript
// ═══════════════════════════════════════════════════════════
// DEVICE MANAGEMENT COMMANDS
// ═══════════════════════════════════════════════════════════

if (messageText?.trim() === "/dev") {
  log("info", "Received /dev command")
  
  const result = await ICloudCoordination.getDeviceStatus(
    state.useICloudCoordination,
    log
  )
  
  await state.telegram.sendMessage(result.message)
  return
}

if (messageText?.startsWith("/use ")) {
  const selection = messageText.slice(5).trim()
  
  if (!selection) {
    await state.telegram.sendMessage("Usage: /use <number>\nExample: /use 2")
    return
  }
  
  log("info", "Received /use command", { selection })
  
  const result = await ICloudCoordination.activateDeviceByNumberOrName(
    selection,
    state.useICloudCoordination,
    log
  )
  
  await state.telegram.sendMessage(result.message)
  return
}
```

### Bot Commands Menu
In `setMyCommands()` around line 286, add:
```typescript
{ command: "dev", description: "List all devices" },
{ command: "use", description: "Activate device by number" },
```

**Complete example:**
```typescript
const commandsResult = await telegram.setMyCommands([
  { command: "interrupt", description: "Stop the current operation" },
  { command: "plan", description: "Switch to plan mode" },
  { command: "build", description: "Switch to build mode" },
  { command: "review", description: "Review changes [commit|branch|pr]" },
  { command: "rename", description: "Rename the session" },
  { command: "version", description: "Show mirror bot version" },
  { command: "dev", description: "List all devices" },
  { command: "use", description: "Activate device by number" },
])
```

## ✨ **Key Features**

### 1. Numbered Selection
- Devices numbered [1], [2], [3], etc.
- Active device always #1
- Easy to type: `/use 2` instead of long device ID

### 2. Smart Sorting
- Active device first
- Then by most recently seen
- Consistent numbering across calls

### 3. Dual Selection Mode
```bash
/use 2                              # By number (easy)
/use laptop@MacBook-Pro:/project    # By full name (precise)
```

### 4. Short Commands
- `/dev` instead of `/devices` (3 chars shorter)
- `/use` instead of `/activate` (5 chars shorter)
- Faster to type on mobile

## 🧪 **Testing**

### Test 1: List Devices

```bash
# Start 2 devices
Device A: bunx opencode-telegram-mirror .
Device B: cd /other && bunx opencode-telegram-mirror .

# In Telegram
/dev
# Should show both with [1] [2]
```

### Test 2: Use Number

```bash
/use 2
# Should activate device #2
# Response: "✅ Device #2 "..." is now ACTIVE"
```

### Test 3: Verify Renumbering

```bash
/dev
# Active device should now be [1]
# Previous [1] is now [2]
```

### Test 4: Use Full Name

```bash
/use laptop@MacBook-Pro:/Users/me/project-a
# Should work with full device ID too
```

### Test 5: Invalid Number

```bash
/use 999
# Response: "❌ Device #999 not found. Use /dev to see available devices."
```

### Test 6: Missing Argument

```bash
/use
# Response: "Usage: /use <number>\nExample: /use 2"
```

## 💡 **Tips**

### Shortening Device IDs

Use `DEVICE_NAME` environment variable:

```bash
# Instead of:
# MacBook-Pro.local:/Users/john/very/long/path/to/project

# Use custom name:
export DEVICE_NAME="laptop"
# Result: laptop@MacBook-Pro.local:/Users/john/very/long/path/to/project

# Even better:
export DEVICE_NAME="work"
# Result: work@MacBook-Pro.local:/Users/john/very/long/path/to/project
```

### Quick Workflow

```bash
# Check status
/dev

# Switch
/use 2

# Confirm
/dev
```

### Mobile-Friendly

Commands are short and easy to type on mobile:
- Type: `/dev` → tap
- Read: Device [2] is the one I want
- Type: `/use 2` → tap
- Done!

## 🎯 **How Numbering Works**

### Sorting Algorithm

```typescript
1. Active device → always first
2. Sort remaining by lastSeen (most recent first)
3. Assign numbers 1, 2, 3, ...
```

### Example Scenarios

**Scenario 1: Device A active, B and C idle**
```
[1] 🟢 Device A (active)
[2] ⚪ Device B (seen 1m ago)
[3] ⚪ Device C (seen 5m ago)
```

**Scenario 2: Switch to Device B**
```
/use 2
```

**Result: New numbering**
```
[1] 🟢 Device B (active)  ← Was #2, now #1
[2] ⚪ Device A (seen 1s ago)  ← Was #1, now #2
[3] ⚪ Device C (seen 5m ago)  ← Still #3
```

**Why?** Active device always #1 for consistency

## 📊 **Comparison**

| Aspect | Old (`/devices`, `/activate`) | New (`/dev`, `/use`) |
|--------|------------------------------|----------------------|
| **List command** | 8 characters | 4 characters (50% shorter) |
| **Activate command** | 10+ characters | 6+ characters |
| **Device selection** | Copy long ID | Type number |
| **Mobile friendly** | ⚠️ Tedious | ✅ Easy |
| **Typo risk** | High (long IDs) | Low (just number) |
| **Speed** | Slow | **Fast** |

## 🎉 **Summary**

### What You Get

- ✅ Short commands: `/dev`, `/use`
- ✅ Numbered devices: [1], [2], [3]
- ✅ Easy selection: `/use 2`
- ✅ Smart sorting: active first
- ✅ Dual mode: number or full name
- ✅ Mobile friendly: fast to type
- ✅ Error messages: clear and helpful

### Implementation

1. **Copy 2 handlers** to main.ts (from above)
2. **Update bot commands** menu
3. **Test in Telegram**

**Done! Much better UX.**

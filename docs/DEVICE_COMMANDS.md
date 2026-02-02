# Device Management Commands - Implementation Guide

## 📋 **Commands Overview**

| Command | Description | Example |
|---------|-------------|---------|
| `/devices` | List all registered devices with status | `/devices` |
| `/activate <device-id>` | Make a specific device active | `/activate laptop@Mac.local:/project-a` |

## 🔧 **Add to main.ts**

### Location

Add these handlers in `handleTelegramMessage()` function, after the existing commands (around line 782, after `/version`).

### Code to Add

```typescript
// ═══════════════════════════════════════════════════════════
// DEVICE MANAGEMENT COMMANDS
// ═══════════════════════════════════════════════════════════

if (messageText?.trim() === "/devices") {
  log("info", "Received /devices command")
  
  const result = await ICloudCoordination.getDeviceStatus(
    state.useICloudCoordination,
    log
  )
  
  await state.telegram.sendMessage(result.message)
  return
}

if (messageText?.startsWith("/activate ")) {
  const targetDevice = messageText.slice(10).trim()
  
  log("info", "Received /activate command", { targetDevice })
  
  const result = await ICloudCoordination.activateDevice(
    targetDevice,
    state.useICloudCoordination,
    log
  )
  
  await state.telegram.sendMessage(result.message)
  return
}
```

### Complete Context (where to insert)

```typescript
async function handleTelegramMessage(
  state: BotState,
  msg: NonNullable<TelegramUpdate["message"]>,
) {
  const messageText = msg.text || msg.caption
  // ... existing checks ...

  if (messageText?.trim() === "/version") {
    const pkg = await import("../package.json")
    const sendResult = await state.telegram.sendMessage(
      `opencode-telegram-mirror v${pkg.version}`
    )
    if (sendResult.status === "error") {
      log("error", "Failed to send version response", {
        error: sendResult.error.message,
      })
    }
    return
  }

  // ──────────────────────────────────────────────────────────
  // INSERT DEVICE MANAGEMENT COMMANDS HERE ↓
  // ──────────────────────────────────────────────────────────

  if (messageText?.trim() === "/devices") {
    log("info", "Received /devices command")
    
    const result = await ICloudCoordination.getDeviceStatus(
      state.useICloudCoordination,
      log
    )
    
    await state.telegram.sendMessage(result.message)
    return
  }

  if (messageText?.startsWith("/activate ")) {
    const targetDevice = messageText.slice(10).trim()
    
    log("info", "Received /activate command", { targetDevice })
    
    const result = await ICloudCoordination.activateDevice(
      targetDevice,
      state.useICloudCoordination,
      log
    )
    
    await state.telegram.sendMessage(result.message)
    return
  }

  // ──────────────────────────────────────────────────────────
  // END OF DEVICE MANAGEMENT COMMANDS ↑
  // ──────────────────────────────────────────────────────────

  if (messageText?.trim() === "/interrupt") {
    // ... existing /interrupt handler ...
  }

  // ... rest of existing handlers ...
}
```

## 🎮 **Usage Examples**

### Example 1: Check Device Status

```
You: /devices

Bot:
*Registered Devices:*

🟢 ACTIVE `MacBook-Pro.local:/Users/me/project-a`
  Thread: 123
  Last seen: 2s ago
  Heartbeat: 1s ago ✅

⚪ Standby `iMac.local:/Users/me/project-b`
  Thread: 456
  Last seen: 45s ago

⚪ Standby `work@MacBook-Pro.local:/Users/me/client-x`
  Thread: 789
  Last seen: 3m 12s ago

_Heartbeat timeout: 90s_
```

**What it shows:**
- 🟢 = Active device
- ⚪ = Standby device
- Device ID (for copy/paste to `/activate`)
- Thread ID each device monitors
- Last seen timestamp
- Heartbeat status (only for active device)
- ✅ = Healthy, ⚠️ = Stale

### Example 2: Switch to Different Device

```
You: /activate iMac.local:/Users/me/project-b

Bot: ✅ Device "iMac.local:/Users/me/project-b" is now ACTIVE
```

**What happens:**
1. Old active device sees state change → becomes standby
2. New device becomes active → starts polling Telegram
3. Immediate switch (no waiting)

### Example 3: Device ID Too Long?

If device IDs are too long to type, use custom names:

```bash
# On laptop
export DEVICE_NAME="laptop"
bunx opencode-telegram-mirror .

# On desktop  
export DEVICE_NAME="desktop"
bunx opencode-telegram-mirror .

# Result:
# Device IDs: "laptop@MacBook-Pro.local:/path" and "desktop@iMac.local:/path"
# Much easier to type!
```

Then in Telegram:
```
You: /activate laptop@MacBook-Pro.local:/Users/me/project-a
# or just use tab completion to paste the ID
```

### Example 4: Device Not Found

```
You: /activate nonexistent-device

Bot: ❌ Failed to activate device: Device not registered
```

### Example 5: iCloud Coordination Disabled

```
You: /devices

Bot: iCloud coordination not enabled
```

**Fix:** Set `USE_ICLOUD_COORDINATOR=true` environment variable

## 🧪 **Testing the Commands**

### Test 1: List Devices

```bash
# Terminal 1
export DEVICE_NAME="dev-laptop"
bunx opencode-telegram-mirror .

# Terminal 2
export DEVICE_NAME="dev-desktop"
cd /other/directory
bunx opencode-telegram-mirror .

# In Telegram
/devices
# Should show both devices
```

### Test 2: Activate Device

```bash
# After running /devices to see device IDs

# In Telegram
/activate dev-laptop@MacBook-Pro.local:/Users/me/project-a

# Check logs in both terminals
# Terminal 1 should show: "Device became active"
# Terminal 2 should show: "Device became standby"
```

### Test 3: Verify Switch

```bash
# After activation
/devices

# Should show:
# 🟢 ACTIVE dev-laptop@...
# ⚪ Standby dev-desktop@...
```

### Test 4: Quick Switch

```bash
# Rapid switching
/activate dev-desktop@...
/devices
# Desktop should now be active

/activate dev-laptop@...
/devices
# Laptop should now be active
```

## 🎯 **How It Works**

### `/devices` Command Flow

```
User sends /devices
     ↓
handleTelegramMessage()
     ↓
ICloudCoordination.getDeviceStatus()
     ↓
Read state.json (active device)
Read devices/*.json (all devices)
     ↓
Format status message
     ↓
Send to Telegram
```

### `/activate` Command Flow

```
User sends /activate <device-id>
     ↓
handleTelegramMessage()
     ↓
Extract device ID from message
     ↓
ICloudCoordination.activateDevice()
     ↓
Read state.json
Update: activeDevice = <device-id>
Update: activeDeviceHeartbeat = now
Write state.json
     ↓
Send confirmation to Telegram
     ↓
iCloud syncs to all devices (~5-30s)
     ↓
Old active becomes standby ⚪
New device becomes active 🟢
```

## 🔒 **Security Considerations**

### Who Can Use Commands?

**Current behavior:** Anyone in the configured chat/thread can use commands

**To restrict:**
1. Add user ID check in command handlers
2. Only allow specific Telegram user IDs
3. Require authentication token

```typescript
// Example: Restrict to specific users
const ALLOWED_USERS = [123456789, 987654321] // Your user IDs

if (messageText?.startsWith("/activate ")) {
  if (!ALLOWED_USERS.includes(msg.from?.id ?? 0)) {
    await state.telegram.sendMessage("❌ Unauthorized")
    return
  }
  // ... rest of handler
}
```

### Accidental Activation

**Risk:** Someone accidentally activates wrong device

**Mitigation:**
1. Device IDs are explicit (not "device1", "device2")
2. Confirmation message shows full device ID
3. Can quickly switch back with `/activate`

## 📝 **Bot Commands Registration**

Add these to the bot commands menu (in main.ts around line 286):

```typescript
const commandsResult = await telegram.setMyCommands([
  { command: "interrupt", description: "Stop the current operation" },
  { command: "plan", description: "Switch to plan mode" },
  { command: "build", description: "Switch to build mode" },
  { command: "review", description: "Review changes [commit|branch|pr]" },
  { command: "rename", description: "Rename the session" },
  { command: "version", description: "Show mirror bot version" },
  { command: "devices", description: "List all registered devices" },        // ← ADD
  { command: "activate", description: "Activate a specific device" },        // ← ADD
])
```

This adds the commands to Telegram's autocomplete menu.

## 🎉 **Summary**

### What to Add

1. ✅ Two command handlers in `handleTelegramMessage()`
2. ✅ Two entries in `setMyCommands()`
3. ✅ Import `ICloudCoordination` (already done if following guides)

### What You Get

- 📋 List all devices with status
- 🎯 Switch active device instantly
- 🟢 Visual status indicators
- ⏱️ Last seen timestamps
- ❤️ Heartbeat health indicators

### Quick Start

```typescript
// 1. Add handlers (copy from above)
if (messageText?.trim() === "/devices") { ... }
if (messageText?.startsWith("/activate ")) { ... }

// 2. Update bot commands
{ command: "devices", description: "List all registered devices" },
{ command: "activate", description: "Activate a specific device" },

// 3. Test in Telegram
/devices
/activate <device-id>
```

**That's it! Device management is now fully functional.**

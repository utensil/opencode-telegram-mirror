# Quick Reference - Device Management

## 📱 Telegram Commands

### List Devices
```
/devices
```

Shows all registered devices with:
- 🟢 Active / ⚪ Standby status
- Device ID
- Thread ID
- Last seen time
- Heartbeat health (active only)

### Activate Device
```
/activate <device-id>
```

Switch to a different device immediately.

**Tip:** Copy device ID from `/devices` output

## 🔧 Code to Add to main.ts

### Location
In `handleTelegramMessage()` after `/version` command (around line 782)

### Code
```typescript
if (messageText?.trim() === "/devices") {
  const result = await ICloudCoordination.getDeviceStatus(
    state.useICloudCoordination,
    log
  )
  await state.telegram.sendMessage(result.message)
  return
}

if (messageText?.startsWith("/activate ")) {
  const targetDevice = messageText.slice(10).trim()
  const result = await ICloudCoordination.activateDevice(
    targetDevice,
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
{ command: "devices", description: "List all registered devices" },
{ command: "activate", description: "Activate a specific device" },
```

## 🎮 Example Session

```
You: /devices

Bot:
*Registered Devices:*

🟢 ACTIVE `laptop@MacBook-Pro:/project-a`
  Thread: 123
  Last seen: 2s ago
  Heartbeat: 1s ago ✅

⚪ Standby `desktop@iMac:/project-b`
  Thread: 456
  Last seen: 45s ago

You: /activate desktop@iMac:/project-b

Bot: ✅ Device "desktop@iMac:/project-b" is now ACTIVE

You: /devices

Bot:
*Registered Devices:*

⚪ Standby `laptop@MacBook-Pro:/project-a`
  Thread: 123
  Last seen: 2s ago

🟢 ACTIVE `desktop@iMac:/project-b`
  Thread: 456
  Last seen: 1s ago
  Heartbeat: 1s ago ✅
```

## ✅ Implementation Status

- ✅ Backend functions: Already implemented in `src/icloud-integration.ts`
- ✅ Command parsing: Just add handlers to main.ts
- ✅ Status formatting: Automatic (includes emojis, timing, health)
- ✅ Error handling: Built-in (device not found, coordination disabled)

**Ready to use - just add the 2 command handlers!**

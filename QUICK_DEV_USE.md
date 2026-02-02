# Quick Reference - /dev and /use Commands

## 📱 **Commands**

```
/dev          List devices (numbered)
/use 2        Activate device by number
```

## 🎮 **Example**

```
You: /dev

Bot:
🟢 ACTIVE [1] `laptop@Mac:/project-a`
⚪ Standby [2] `desktop@iMac:/project-b`
⚪ Standby [3] `work@Mac:/client-x`

You: /use 2

Bot: ✅ Device #2 "desktop@iMac:/project-b" is now ACTIVE
```

## 🔧 **Code for main.ts**

### Add after /version (line ~782)

```typescript
if (messageText?.trim() === "/dev") {
  const result = await ICloudCoordination.getDeviceStatus(
    state.useICloudCoordination, log
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
  const result = await ICloudCoordination.activateDeviceByNumberOrName(
    selection, state.useICloudCoordination, log
  )
  await state.telegram.sendMessage(result.message)
  return
}
```

### Update setMyCommands() (line ~286)

```typescript
{ command: "dev", description: "List all devices" },
{ command: "use", description: "Activate device by number" },
```

## ✨ **Features**

- ✅ Short: `/dev` not `/devices`
- ✅ Numbered: [1], [2], [3]
- ✅ Easy: `/use 2` not long device ID
- ✅ Smart: Active always #1
- ✅ Fast: Mobile-friendly

**Copy code, paste, done!**

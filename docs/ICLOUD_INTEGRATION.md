# iCloud Coordination Integration Guide

This guide shows how to integrate iCloud-based device coordination into the Telegram mirror.

## Files Created

1. **`src/icloud-coordinator.ts`** - Core iCloud coordination logic
2. **`src/icloud-integration.ts`** - Integration layer for main.ts

## Changes Required in `src/main.ts`

### 1. Add imports (after line 14)

```typescript
import * as ICloudCoordination from "./icloud-integration"
```

### 2. Add to BotState interface (around line 156)

```typescript
interface BotState {
  // ... existing fields ...
  
  // New fields for device coordination
  deviceName: string
  useICloudCoordination: boolean
}
```

### 3. Initialize coordination in main() (after line 297)

```typescript
// Around line 297, after bot commands are set

// Initialize device coordination
log("info", "Initializing device coordination...")
const coordination = await ICloudCoordination.initializeCoordination(
  config.threadId ?? null,
  log
)

log("info", "Device coordination initialized", {
  deviceName: coordination.deviceName,
  useICloud: coordination.useICloud,
  mode: coordination.useICloud ? "iCloud shared state" : "local database",
})
```

### 4. Add coordination fields to BotState (around line 327)

```typescript
const state: BotState = {
  // ... existing fields ...
  
  deviceName: coordination.deviceName,
  useICloudCoordination: coordination.useICloud,
}
```

### 5. Modify startUpdatesPoller to check if device is active (around line 535)

```typescript
async function startUpdatesPoller(state: BotState) {
  const pollSource = state.updatesUrl ? "Cloudflare DO" : "Telegram API"

  // ... existing startup code ...

  let pollCount = 0
  let totalUpdatesProcessed = 0
  let heartbeatCounter = 0

  while (true) {
    try {
      pollCount++
      heartbeatCounter++
      
      // Send heartbeat every 10 polls (~50 seconds)
      if (heartbeatCounter >= 10) {
        await ICloudCoordination.sendHeartbeat(
          state.deviceName,
          state.useICloudCoordination,
          log
        )
        heartbeatCounter = 0
      }
      
      // Check if this device is active
      const isActive = await ICloudCoordination.checkIfActive(
        state.deviceName,
        state.useICloudCoordination,
        log
      )
      
      if (!isActive) {
        log("debug", "Device is in standby mode", { 
          device: state.deviceName,
          pollCount,
        })
        await Bun.sleep(5000) // Wait 5 seconds before checking again
        continue
      }
      
      const pollStart = Date.now()
      
      let updates = state.updatesUrl
        ? await pollFromDO(state)
        : await pollFromTelegram(state)
      
      // ... rest of existing polling logic ...
```

### 6. Replace getLastUpdateId/setLastUpdateId calls in pollFromTelegram (around line 669)

```typescript
async function pollFromTelegram(state: BotState): Promise<TelegramUpdate[]> {
  // REPLACE: const lastUpdateId = getLastUpdateId(log)
  const lastUpdateId = await ICloudCoordination.getUpdateId(
    state.useICloudCoordination,
    log
  )
  
  const baseUrl = `https://api.telegram.org/bot${state.botToken}`

  const params = new URLSearchParams({
    offset: String(lastUpdateId + 1),
    timeout: "30",
    allowed_updates: JSON.stringify(["message", "callback_query"]),
  })

  const response = await fetch(`${baseUrl}/getUpdates?${params}`)
  const data = (await response.json()) as {
    ok: boolean
    result?: TelegramUpdate[]
  }

  if (!data.ok || !data.result) {
    return []
  }

  // Filter to our chat and update last ID
  const updates: TelegramUpdate[] = []
  for (const update of data.result) {
    // REPLACE: setLastUpdateId(update.update_id, log)
    await ICloudCoordination.setUpdateId(
      update.update_id,
      state.deviceName,
      state.useICloudCoordination,
      log
    )

    const chatId =
      update.message?.chat.id || update.callback_query?.message?.chat.id
    if (String(chatId) === state.chatId) {
      updates.push(update)
    }
  }

  return updates
}
```

### 7. Add device management commands in handleTelegramMessage (around line 782)

```typescript
// Add after the /version command handler (around line 782)

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

if (messageText?.trim() === "/devices") {
  const result = await ICloudCoordination.getDeviceStatus(
    state.useICloudCoordination,
    log
  )
  
  await state.telegram.sendMessage(result.message)
  return
}
```

## Environment Variables

### Required for all devices:

```bash
export TELEGRAM_BOT_TOKEN="your-bot-token"
export TELEGRAM_CHAT_ID="your-chat-id"
```

### Device-specific (each device):

```bash
# Device A (Laptop)
export DEVICE_NAME="laptop"
export TELEGRAM_THREAD_ID="123"
export USE_ICLOUD_COORDINATOR="true"

# Device B (Desktop)
export DEVICE_NAME="desktop"
export TELEGRAM_THREAD_ID="456"
export USE_ICLOUD_COORDINATOR="true"
```

### Optional:

```bash
# Disable iCloud coordination (use local database)
export USE_ICLOUD_COORDINATOR="false"
```

## Usage

### 1. Start both devices:

```bash
# Device A
export DEVICE_NAME="laptop"
bunx opencode-telegram-mirror .

# Device B
export DEVICE_NAME="desktop"
bunx opencode-telegram-mirror .
```

Both devices will start in **standby mode** (no device is active initially).

### 2. Check device status:

```
You: /devices
Bot:
  ⚪ Standby laptop
     Thread: 123
     Last seen: 3s ago
  
  ⚪ Standby desktop
     Thread: 456
     Last seen: 2s ago
```

### 3. Activate a device:

```
You: /activate laptop
Bot: ✅ Device "laptop" is now ACTIVE

# Now send messages in Thread 123
You: Hello
Bot: [Laptop's OpenCode agent responds]
```

### 4. Switch devices:

```
You: /activate desktop
Bot: ✅ Device "desktop" is now ACTIVE

# Now send messages in Thread 456
You: Help me
Bot: [Desktop's OpenCode agent responds]
```

## How It Works

1. **iCloud Drive Sync**: Both devices read/write to `~/Library/Mobile Documents/com~apple~CloudDocs/opencode-telegram-mirror/`

2. **Shared State Files**:
   - `state.json` - Tracks active device and last update ID
   - `devices.json` - Lists all registered devices

3. **Active Device Polling**:
   - Only the active device polls Telegram API
   - Inactive devices sleep and check iCloud state every 5 seconds

4. **Automatic Failover**:
   - If active device becomes unavailable, activate another manually
   - Devices update their "last seen" timestamp via heartbeat

5. **No Network Required** (between devices):
   - All coordination via iCloud file sync
   - Devices can be on different networks
   - Only need internet to reach Telegram API

## Troubleshooting

### "iCloud Drive not found"

```bash
# Check if iCloud Drive is enabled
ls -la ~/Library/Mobile\ Documents/com~apple~CloudDocs/

# If missing, enable iCloud Drive in System Settings
```

### Both devices responding

- Check that only one device shows as "ACTIVE" in `/devices`
- Verify iCloud sync is working: `ls -la ~/Library/Mobile\ Documents/com~apple~CloudDocs/opencode-telegram-mirror/`
- Check file timestamps to confirm sync

### Devices not seeing each other

- iCloud Drive sync can take 5-30 seconds
- Force sync: Open Finder → iCloud Drive → wait for sync icon
- Check System Settings → iCloud → iCloud Drive is enabled

## Testing Without iCloud

```bash
# Disable iCloud coordination
export USE_ICLOUD_COORDINATOR="false"

# This will use local SQLite database instead
bunx opencode-telegram-mirror .
```

This falls back to the original single-device behavior.

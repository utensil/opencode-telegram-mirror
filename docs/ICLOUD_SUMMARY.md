# iCloud-Based Multi-Device Coordination

## Summary

This implementation allows you to run the OpenCode Telegram mirror on **multiple isolated Mac devices** (laptop, desktop, etc.) using **iCloud Drive as shared state**, without requiring any public internet server or network connectivity between devices.

## What Was Built

### New Files

1. **`src/icloud-coordinator.ts`** (268 lines)
   - Core coordination logic
   - Reads/writes to iCloud Drive local path
   - Manages device registry and active state
   - Handles last update ID synchronization

2. **`src/icloud-integration.ts`** (202 lines)
   - Integration layer for main.ts
   - Provides fallback to local database if iCloud unavailable
   - Wrapper functions for device activation, status, heartbeat

3. **`ICLOUD_INTEGRATION.md`** (Documentation)
   - Complete integration guide
   - Step-by-step changes for main.ts
   - Usage examples and troubleshooting

## Architecture

```
Device A (Laptop)                    Device B (Desktop)
├─ Mirror bot running                ├─ Mirror bot running  
├─ Checks iCloud state               ├─ Checks iCloud state
├─ Active? Poll Telegram             ├─ Active? Sleep
└─ Updates iCloud state              └─ Waits for activation
         │                                    │
         └────────────────┬───────────────────┘
                          ▼
         iCloud Drive (auto-sync between Macs)
         ~/Library/Mobile Documents/com~apple~CloudDocs/
         └── opencode-telegram-mirror/
             ├── state.json      (active device, last update ID)
             └── devices.json    (registered devices)
```

## Key Features

### ✅ **Solves Your Requirements**

- ✅ Run both devices simultaneously
- ✅ Choose which device responds (via `/activate` command)
- ✅ No public internet server required
- ✅ No network connectivity needed between devices
- ✅ Uses only local iCloud Drive path (macOS native)
- ✅ Simple design - just file read/write
- ✅ Device registration and management

### 🎮 **User Experience**

```bash
# Start both devices
Device A: bunx opencode-telegram-mirror .  # Standby
Device B: bunx opencode-telegram-mirror .  # Standby

# In Telegram
You: /devices
Bot: ⚪ Standby laptop (Thread: 123)
     ⚪ Standby desktop (Thread: 456)

You: /activate laptop
Bot: ✅ Device "laptop" is now ACTIVE

You: Hello (in Thread 123)
Bot: [Laptop responds]

You: /activate desktop
Bot: ✅ Device "desktop" is now ACTIVE

You: Help (in Thread 456)
Bot: [Desktop responds]
```

## How It Works

### 1. Device Registration

On startup, each device:
- Reads `DEVICE_NAME` from environment
- Registers itself in `devices.json` on iCloud Drive
- Includes: name, threadId, lastSeen timestamp, hostname

### 2. Active Device Check

Every polling cycle (~5 seconds):
- Device reads `state.json` from iCloud Drive
- Checks if `activeDevice` field matches its name
- If **active**: Polls Telegram API and processes messages
- If **standby**: Sleeps and checks again in 5 seconds

### 3. Device Activation

When you send `/activate laptop`:
1. Bot reads `state.json`
2. Sets `activeDevice: "laptop"`
3. Writes back to iCloud Drive
4. iCloud syncs to all devices (~5-30 seconds)
5. Laptop starts polling, desktop goes standby

### 4. Update ID Synchronization

- Last processed `update_id` stored in iCloud `state.json`
- Active device updates it after each poll
- When devices switch, new device continues from same ID
- Prevents message duplication or loss

### 5. Heartbeat Mechanism

Every ~50 seconds:
- Device updates its `lastSeen` timestamp in `devices.json`
- Other devices can see when each was last active
- Useful for detecting dead/crashed devices

## Implementation Status

### ✅ Completed

- Core coordinator module
- Integration layer with fallback
- Device registration system
- Active device checking
- State synchronization
- Heartbeat mechanism
- Documentation and guide

### 📝 Requires Manual Integration

The following changes need to be made to `src/main.ts`:

1. Add import for `icloud-integration.ts`
2. Add `deviceName` and `useICloudCoordination` to `BotState`
3. Initialize coordination on startup
4. Modify polling loop to check if device is active
5. Replace `getLastUpdateId/setLastUpdateId` with coordination wrappers
6. Add `/activate` and `/devices` commands

**See `ICLOUD_INTEGRATION.md` for exact code changes.**

## Configuration

### Environment Variables

```bash
# Required (all devices)
export TELEGRAM_BOT_TOKEN="your-bot-token"
export TELEGRAM_CHAT_ID="your-chat-id"

# Device-specific
export DEVICE_NAME="laptop"              # Unique name per device
export TELEGRAM_THREAD_ID="123"          # Thread to monitor (optional)
export USE_ICLOUD_COORDINATOR="true"     # Enable iCloud coordination

# Optional
export COLLECTOR_PORT="3939"             # Not used in iCloud mode
```

### Device Names

Choose short, memorable names:
- `laptop`, `desktop`, `work`, `home`
- `macbook`, `imac`, `mac-studio`
- `dev`, `prod`, `test`

## Benefits Over Alternatives

| Approach | Network? | Public Server? | Complexity | This Solution |
|----------|----------|----------------|------------|---------------|
| Central collector | ✅ Required | ✅ Yes | High | ❌ No |
| VPN/Tailscale | ✅ Required | ⚠️ Mesh | Medium | ❌ No |
| Different bot tokens | ❌ No | ❌ No | Low | ✅ Better UX |
| Manual switching | ❌ No | ❌ No | Manual | ✅ Automated |
| **iCloud Drive** | ❌ No | ❌ No | Low | ✅ **This!** |

## Limitations

### iCloud Drive Sync Delay

- Typical: 5-30 seconds
- Can be longer under poor network conditions
- Not suitable for real-time switching (< 5s)

**Mitigation**: Acceptable for coding sessions where switching happens infrequently

### macOS Only

- Uses macOS-specific iCloud Drive path
- Won't work on Linux/Windows

**Mitigation**: Falls back to local database mode gracefully

### File Lock Contention

- No distributed file locking
- Race conditions possible if both devices write simultaneously

**Mitigation**: Only active device writes state frequently; low probability of conflict

### iCloud Drive Required

- Users must have iCloud Drive enabled
- Requires Apple ID and iCloud storage

**Mitigation**: Check on startup, fall back to local mode if unavailable

## Future Enhancements

### Priority-Based Activation

```typescript
// Device A (priority 1) fails → auto-activate Device B (priority 2)
export DEVICE_PRIORITY="1"
```

### Auto-Activation on Last Seen

```typescript
// If active device hasn't sent heartbeat in 2 minutes, auto-switch
if (timeSinceHeartbeat > 120000) {
  activateNextDevice()
}
```

### Per-Thread Device Assignment

```json
{
  "threads": {
    "123": "laptop",   // Thread 123 always uses laptop
    "456": "desktop"   // Thread 456 always uses desktop
  }
}
```

### Web UI for Device Management

```bash
# Local web dashboard
open http://localhost:3939/dashboard
```

## Testing

### 1. Test iCloud Path

```bash
ls -la ~/Library/Mobile\ Documents/com~apple~CloudDocs/
```

### 2. Test File Creation

```bash
mkdir -p ~/Library/Mobile\ Documents/com~apple~CloudDocs/opencode-telegram-mirror
echo '{"test": true}' > ~/Library/Mobile\ Documents/com~apple~CloudDocs/opencode-telegram-mirror/test.json
```

### 3. Test Sync Between Devices

```bash
# Device A
echo "from-laptop" > ~/Library/Mobile\ Documents/com~apple~CloudDocs/opencode-telegram-mirror/sync-test.txt

# Wait 30 seconds, then on Device B
cat ~/Library/Mobile\ Documents/com~apple~CloudDocs/opencode-telegram-mirror/sync-test.txt
# Should show "from-laptop"
```

### 4. Test Coordinator Module

```bash
bun test src/icloud-coordinator.ts
```

## Security Considerations

### Files in iCloud

- State files contain: device names, thread IDs, update IDs
- No bot tokens or sensitive credentials stored
- iCloud Drive is encrypted in transit and at rest

### Local File Permissions

```bash
# iCloud Drive files are user-only by default
ls -la ~/Library/Mobile\ Documents/com~apple~CloudDocs/opencode-telegram-mirror/
# Should show: -rw-------  (600 permissions)
```

### Attack Scenarios

1. **Attacker gains iCloud access**
   - Can see device names and thread IDs
   - Cannot control bot (no bot token in state files)
   - Mitigation: Use strong Apple ID password + 2FA

2. **Attacker modifies state.json**
   - Can activate wrong device
   - Can cause confusion/disruption
   - Cannot execute code or steal data
   - Mitigation: Monitor device activity, re-activate manually

## Next Steps

To complete the implementation:

1. **Review the code**
   - `src/icloud-coordinator.ts`
   - `src/icloud-integration.ts`
   
2. **Read the integration guide**
   - `ICLOUD_INTEGRATION.md`
   
3. **Make changes to main.ts**
   - Follow step-by-step instructions in guide
   
4. **Test with one device first**
   ```bash
   export DEVICE_NAME="test"
   export USE_ICLOUD_COORDINATOR="true"
   bunx opencode-telegram-mirror .
   ```

5. **Verify iCloud files created**
   ```bash
   cat ~/Library/Mobile\ Documents/com~apple~CloudDocs/opencode-telegram-mirror/state.json
   ```

6. **Add second device**
   - Different `DEVICE_NAME`
   - Different `TELEGRAM_THREAD_ID` (optional)

7. **Test activation switching**
   ```
   /devices
   /activate test
   ```

## Support

If you encounter issues:

1. Check iCloud Drive is enabled: System Settings → iCloud → iCloud Drive
2. Verify path exists: `ls ~/Library/Mobile\ Documents/com~apple~CloudDocs/`
3. Check logs for coordinator errors
4. Disable iCloud coordination temporarily: `export USE_ICLOUD_COORDINATOR="false"`

---

**This design solves your exact requirement: Multiple isolated devices, no public server, simple file-based coordination via iCloud Drive.**
